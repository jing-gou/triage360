import { describe, expect, it } from "vitest";
import {
  credentialFromTokens,
  decideCredentialAction,
  recordRefreshAttempt,
  rotateCredential,
  type CredentialRecord,
} from "../src/core/credentials";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** 2026-11-17T09:00:00Z，与其余 seam 测试同一根时间轴。 */
const T = Date.UTC(2026, 10, 17, 9);
/** 一枚有效期一天的 token（Gitee 的口径），拿到它时离过期还有一整天。 */
const EXPIRES = T + DAY;

function at(now: number, overrides: Partial<Parameters<typeof decideCredentialAction>[0]> = {}) {
  return decideCredentialAction({
    now,
    expiresAt: EXPIRES,
    lastRefreshAt: T - HOUR,
    isDemoTenant: false,
    ...overrides,
  });
}

describe("seam 2 · 凭据生命周期决策器：动作", () => {
  it("离过期还远就照常 serve，两种租户一致", () => {
    expect(at(T)).toBe("serve");
    expect(at(T, { isDemoTenant: true })).toBe("serve");
  });

  it("没有已知过期时刻就 serve，不去猜", () => {
    expect(at(T, { expiresAt: null })).toBe("serve");
    expect(at(T, { expiresAt: null, isDemoTenant: true })).toBe("serve");
  });

  it("进入提前量（过期前 5 分钟）才开始刷：真实租户懒刷新、演示租户走定时", () => {
    // 边界写死字面值：常量若被改小/改大，这里要变红，而不是跟着实现一起漂。
    expect(at(EXPIRES - 5 * MIN - 1)).toBe("serve");
    expect(at(EXPIRES - 5 * MIN)).toBe("lazy-refresh");
    expect(at(EXPIRES - 1)).toBe("lazy-refresh");
    expect(at(EXPIRES - 5 * MIN, { isDemoTenant: true })).toBe("scheduled-refresh");
    expect(at(EXPIRES - 1, { isDemoTenant: true })).toBe("scheduled-refresh");
  });

  it("已过期但还没试过刷新：真实租户先懒刷新一次，演示租户交给定时（带锁）", () => {
    expect(at(EXPIRES + HOUR, { lastRefreshAt: null })).toBe("lazy-refresh");
    expect(at(EXPIRES + HOUR)).toBe("lazy-refresh");
    expect(at(EXPIRES + HOUR, { lastRefreshAt: null, isDemoTenant: true })).toBe("scheduled-refresh");
    expect(at(EXPIRES + HOUR, { isDemoTenant: true })).toBe("scheduled-refresh");
  });

  it("过期之后已经刷新过仍过期：去重连，不返回空列表", () => {
    // last_refresh_at 记的是「最近一次刷新尝试」，失败也记：过期后试过还在过期
    // 说明这枚 refresh token 已经救不回来，再刷只是空转。
    expect(at(EXPIRES + HOUR, { lastRefreshAt: EXPIRES + MIN })).toBe("expire-to-reauth");
    expect(at(EXPIRES + HOUR, { lastRefreshAt: EXPIRES })).toBe("expire-to-reauth");
    expect(at(EXPIRES + HOUR, { lastRefreshAt: EXPIRES + MIN, isDemoTenant: true })).toBe("expire-to-reauth");
  });

  it("提前量内但上一次尝试落在过期之后（时钟回拨过）：照样去重连，不进刷新循环", () => {
    expect(at(EXPIRES - MIN, { lastRefreshAt: EXPIRES + MIN })).toBe("expire-to-reauth");
  });
});

describe("seam 2 · 凭据生命周期决策器：轮换是原子的", () => {
  const current: CredentialRecord = {
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: EXPIRES,
    lastRefreshAt: T - HOUR,
  };
  const refreshed = {
    accessToken: "new-access",
    refreshToken: "new-refresh",
    expiresAt: EXPIRES + DAY,
  };

  it("落库成功：一对新值一次写入，旧 refresh token 才出现在退役位", () => {
    const writes: CredentialRecord[] = [];
    const outcome = rotateCredential(current, refreshed, (next) => writes.push(next), T);

    expect(writes).toEqual([
      { accessToken: "new-access", refreshToken: "new-refresh", expiresAt: EXPIRES + DAY, lastRefreshAt: T },
    ]);
    expect(outcome).toEqual({
      kind: "committed",
      record: { accessToken: "new-access", refreshToken: "new-refresh", expiresAt: EXPIRES + DAY, lastRefreshAt: T },
      retiredRefreshToken: "old-refresh",
    });
  });

  it("落库抛错：返回原记录、没有退役动作；写进去的若成功也只会是一整对", () => {
    const attempts: CredentialRecord[] = [];
    const outcome = rotateCredential(
      current,
      refreshed,
      (next) => {
        attempts.push(next);
        throw new Error("写库失败");
      },
      T,
    );

    // 交给存储的是一整对，不是先新 access 再补 refresh——没有混合态。
    expect(attempts).toEqual([
      { accessToken: "new-access", refreshToken: "new-refresh", expiresAt: EXPIRES + DAY, lastRefreshAt: T },
    ]);
    expect(outcome).toEqual({ kind: "failed", record: current, retiredRefreshToken: null });
  });

  it("刷新没发新 refresh token 时沿用旧的，不把它清成 null", () => {
    const outcome = rotateCredential(
      current,
      { accessToken: "new-access", refreshToken: null, expiresAt: EXPIRES + DAY },
      () => {},
      T,
    );

    expect(outcome.kind).toBe("committed");
    expect(outcome.record.refreshToken).toBe("old-refresh");
    expect(outcome.retiredRefreshToken).toBeNull();
  });
});

describe("seam 2 · 凭据生命周期决策器：坏一次轮换不丢租户", () => {
  it("失败 → 记一次尝试 → 判定转为重连 → 重连后回到 serve", () => {
    const current: CredentialRecord = {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: EXPIRES,
      lastRefreshAt: null,
    };

    const failed = rotateCredential(
      current,
      { accessToken: "bad", refreshToken: "bad", expiresAt: EXPIRES },
      () => {
        throw new Error("写库失败");
      },
      EXPIRES + MIN,
    );
    expect(failed.kind).toBe("failed");

    // 尝试记录落盘后，下一次判定去重连——租户记录还在，只是要点一次重新连接。
    const attempted = recordRefreshAttempt(failed.record, EXPIRES + MIN);
    expect(
      decideCredentialAction({ now: EXPIRES + 2 * MIN, expiresAt: attempted.expiresAt, lastRefreshAt: attempted.lastRefreshAt, isDemoTenant: false }),
    ).toBe("expire-to-reauth");

    // 重连写入新的一对，判定回到 serve；失败那一次没有留下任何不可恢复的状态。
    const reauthorized = credentialFromTokens({ accessToken: "a2", refreshToken: "r2", expiresAt: EXPIRES + DAY }, EXPIRES + 3 * MIN);
    expect(
      decideCredentialAction({ now: EXPIRES + 3 * MIN, expiresAt: reauthorized.expiresAt, lastRefreshAt: reauthorized.lastRefreshAt, isDemoTenant: false }),
    ).toBe("serve");
  });
});
