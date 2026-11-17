import { randomBytes } from "node:crypto";

/**
 * 会话只活在进程内存里：进程重启等于全员重新授权。
 * 这是 ADR-0008 之后的有意取舍——服务端只留「这次会话用得到的令牌」，
 * 加密落库与删除义务在 #13，那里才会出现持久化。
 */
export interface Session {
  /** GitHub 的 user-to-server token，永不下发给前端。 */
  token: string;
  login: string;
  createdAt: number;
}

export class SessionStore {
  private readonly byId = new Map<string, Session>();

  create(session: Session): string {
    const id = randomBytes(32).toString("base64url");
    this.byId.set(id, session);
    return id;
  }

  get(id: string): Session | undefined {
    return this.byId.get(id);
  }

  delete(id: string): void {
    this.byId.delete(id);
  }
}
