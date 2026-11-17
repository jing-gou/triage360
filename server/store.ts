import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Tier } from "../src/core/provider";

/**
 * 租户账本的落盘层（#13）：一条租户记录 = 会话标识的哈希 + 登录名 + 两个时刻 + 各档授权的密文。
 *
 * 承诺的边界写死在这里：**数据库文件泄露不导致凭据泄露**——token 用 AES-256-GCM 加密，
 * 会话标识只存 SHA-256 哈希（拿到文件也换不到可用的 Bearer），两条共同拦住「只拿到文件」的路径。
 * 它挡不住服务器被完全控制：进程手里有密钥与解密后的 token，那是托管的固有边界，文案里必须说透。
 *
 * 密钥只住同机的 `<dataDir>/store.key`（0600，首次启动生成）；仓库里没有任何密钥。
 * 进程单实例、同步写，整份文件原子替换（tmp + rename）：账本极小，简单比并发花活可靠。
 */

export interface StoredGrant {
  token: string;
  /** GitHub 侧实际授予的 scope（来自 `X-OAuth-Scopes`），用来捕捉「授权被改小」；`null` = 响应头缺失、不知道。 */
  scopes: string[] | null;
}

export interface Tenant {
  /** 会话标识本体只在这一层内存里出现；落盘的是它的哈希。 */
  id: string;
  login: string;
  createdAt: number;
  lastSeenAt: number;
  grants: Partial<Record<Tier, StoredGrant>>;
}

interface StoredTenant {
  idHash: string;
  login: string;
  createdAt: number;
  lastSeenAt: number;
  grants: Partial<Record<Tier, { cipher: string; scopes: string[] | null }>>;
}

interface StoreFile {
  version: 1;
  tenants: StoredTenant[];
}

/** 30 天未访问自动清除的射程：服务端这本条记录（含全部授权），不含浏览器本地。 */
export const INACTIVITY_LIMIT_MS = 30 * 24 * 60 * 60_000;

export class EncryptedStore {
  private readonly key: Buffer;
  private readonly file: string;
  private tenants: StoredTenant[];

  constructor(
    dir: string,
    private readonly now: () => number,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.key = loadOrCreateKey(join(dir, "store.key"));
    this.file = join(dir, "store.json");
    this.tenants = this.readFile();
  }

  /** 第一次授权：新建一条租户记录。返回会话标识（只有它知道原文）。 */
  createTenant(login: string, now: number): string {
    const id = newId();
    this.tenants.push({ idHash: hashId(id), login, createdAt: now, lastSeenAt: now, grants: {} });
    this.persist();
    return id;
  }

  /**
   * 把一档授权落到租户上：`sessionId` 为空就新建租户（首次连接），
   * 非空就合并进已有记录（同一访客的第二档授权）。会话在途期间被撤销就拒绝落盘，
   * 不凭一个已经作废的标识重建出新租户。返回最终会话标识。
   */
  attachGrant(
    sessionId: string | null,
    tier: Tier,
    grant: StoredGrant,
    login: string,
    now: number,
  ): string {
    if (sessionId !== null && this.find(sessionId) === undefined) {
      throw new Error("授权会话已失效");
    }
    const id = sessionId ?? this.createTenant(login, now);
    const tenant = this.tenantRecord(id);
    if (tenant === undefined) throw new Error("租户记录在写入前消失");
    tenant.login = login;
    tenant.lastSeenAt = now;
    tenant.grants[tier] = { cipher: encrypt(this.key, grant.token), scopes: grant.scopes === null ? null : [...grant.scopes] };
    this.persist();
    return id;
  }

  /**
   * 按会话标识取租户并顺带续期 lastSeenAt。续期立刻落盘、不节流：
   * 它就是 30 天清除的判据，文件里的值落后于真实访问就可能提前删人。
   * 30 天清除在这里也做一次惰性扫描；启动与每小时一次的扫描在 index.ts。
   */
  find(sessionId: string): Tenant | undefined {
    this.prune(this.now());
    const idHash = hashId(sessionId);
    const record = this.tenants.find((one) => one.idHash === idHash);
    if (record === undefined) return undefined;
    record.lastSeenAt = this.now();
    this.persist();
    return this.materialize(record, sessionId);
  }

  /** 一档授权被上游判定失效：只删这一档；租户没有剩余授权时整条删除（同样要求验证通过）。 */
  removeGrant(sessionId: string, tier: Tier): void {
    const record = this.tenantRecord(sessionId);
    if (record === undefined) return;
    delete record.grants[tier];
    if (Object.keys(record.grants).length === 0) {
      if (!this.delete(sessionId)) throw new Error("删除验证失败");
    } else {
      this.persist();
    }
  }

  /**
   * 撤销 = 物理删除该租户 token 与该租户在服务端的全部数据，并**当场验证**：
   * 从内存移除、整份重写文件、再把文件读回来确认那条哈希不在。验证不过就返回 false。
   */
  delete(sessionId: string): boolean {
    this.dropTenant(sessionId);
    const idHash = hashId(sessionId);
    if (this.tenants.some((one) => one.idHash === idHash)) return false;
    if (this.readFile().some((one) => one.idHash === idHash)) return false;
    return true;
  }

  /** 上游响应头给出的实际 scope 变了就更新（GitHub 侧被改小时，这里是最早的观测点）。 */
  setScopes(sessionId: string, tier: Tier, scopes: string[]): void {
    const record = this.tenantRecord(sessionId);
    const stored = record?.grants[tier];
    if (stored === undefined) return;
    if (stored.scopes !== null && stored.scopes.length === scopes.length && stored.scopes.every((one, index) => one === scopes[index])) return;
    stored.scopes = [...scopes];
    this.persist();
  }

  /** 30 天未访问的租户整条清除；返回清掉的条数。 */
  prune(now: number): number {
    const before = this.tenants.length;
    this.tenants = this.tenants.filter((one) => now - one.lastSeenAt < INACTIVITY_LIMIT_MS);
    const removed = before - this.tenants.length;
    if (removed > 0) this.persist();
    return removed;
  }

  private dropTenant(sessionId: string): void {
    const idHash = hashId(sessionId);
    const before = this.tenants.length;
    this.tenants = this.tenants.filter((one) => one.idHash !== idHash);
    if (this.tenants.length !== before) this.persist();
  }

  private tenantRecord(sessionId: string): StoredTenant | undefined {
    const idHash = hashId(sessionId);
    return this.tenants.find((one) => one.idHash === idHash);
  }

  private materialize(record: StoredTenant, id: string): Tenant {
    const grants: Tenant["grants"] = {};
    for (const tier of ["public", "private"] as const) {
      const stored = record.grants[tier];
      if (stored !== undefined) {
        grants[tier] = { token: decrypt(this.key, stored.cipher), scopes: stored.scopes === null ? null : [...stored.scopes] };
      }
    }
    return { id, login: record.login, createdAt: record.createdAt, lastSeenAt: record.lastSeenAt, grants };
  }

  private readFile(): StoredTenant[] {
    if (!existsSync(this.file)) return [];
    const raw = readFileSync(this.file, "utf8");
    const parsed = JSON.parse(raw) as StoreFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.tenants)) {
      // 形状不对就起不来：带着半懂的账本继续跑，比停机的代价大。
      throw new Error(`${this.file} 不是 version 1 的账本`);
    }
    return parsed.tenants;
  }

  private persist(): void {
    const body: StoreFile = { version: 1, tenants: this.tenants };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }
}

function newId(): string {
  return randomBytes(32).toString("base64url");
}

function hashId(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

function loadOrCreateKey(path: string): Buffer {
  if (existsSync(path)) {
    const key = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
    if (key.length !== 32) throw new Error(`${path} 不是 32 字节密钥`);
    return key;
  }
  const key = randomBytes(32);
  writeFileSync(path, `${key.toString("base64")}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}

/** AES-256-GCM：iv(12) + authTag(16) + 密文，整体 base64。 */
function encrypt(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

function decrypt(key: Buffer, blob: string): string {
  const packed = Buffer.from(blob, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, packed.subarray(0, 12));
  decipher.setAuthTag(packed.subarray(12, 28));
  return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8");
}
