import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const SESSION_COOKIE = "ronix_session";
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

type Session = { expiresAt: number };
type Attempts = { count: number; resetsAt: number };

export type LoginResult =
  | { ok: true }
  | { ok: false; retryAfterSeconds?: number };

export class AuthManager {
  private readonly sessions = new Map<string, Session>();
  private readonly attempts = new Map<string, Attempts>();

  constructor(
    private readonly key: string,
    private readonly sessionTtlMs: number,
    private readonly secureCookie: boolean,
  ) {}

  get enabled(): boolean {
    return this.key.length > 0;
  }

  authorized(request: IncomingMessage): boolean {
    if (!this.enabled) return true;

    const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    if (bearer && safeEqual(this.key, bearer)) return true;

    const token = parseCookies(request.headers.cookie ?? "")[SESSION_COOKIE];
    if (!token) return false;
    const session = this.sessions.get(token);
    if (!session) return false;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  login(response: ServerResponse, suppliedKey: string, clientId: string): LoginResult {
    if (!this.enabled) return { ok: true };

    const now = Date.now();
    const attempts = this.attempts.get(clientId);
    if (attempts && attempts.resetsAt > now && attempts.count >= MAX_ATTEMPTS) {
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil((attempts.resetsAt - now) / 1000)),
      };
    }

    if (!safeEqual(this.key, suppliedKey)) {
      const current = attempts && attempts.resetsAt > now
        ? attempts
        : { count: 0, resetsAt: now + ATTEMPT_WINDOW_MS };
      current.count += 1;
      this.attempts.set(clientId, current);
      return current.count >= MAX_ATTEMPTS
        ? { ok: false, retryAfterSeconds: Math.ceil((current.resetsAt - now) / 1000) }
        : { ok: false };
    }

    this.attempts.delete(clientId);
    this.deleteExpiredSessions(now);
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, { expiresAt: now + this.sessionTtlMs });
    response.setHeader("set-cookie", serializeCookie(token, this.sessionTtlMs, this.secureCookie));
    return { ok: true };
  }

  logout(request: IncomingMessage, response: ServerResponse): void {
    const token = parseCookies(request.headers.cookie ?? "")[SESSION_COOKIE];
    if (token) this.sessions.delete(token);
    response.setHeader("set-cookie", clearCookie(this.secureCookie));
  }

  private deleteExpiredSessions(now: number): void {
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }
}

function safeEqual(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies[name] = value;
  }
  return cookies;
}

function serializeCookie(token: string, ttlMs: number, secure: boolean): string {
  const attributes = [
    SESSION_COOKIE + "=" + token,
    "Path=/",
    "Max-Age=" + Math.floor(ttlMs / 1000),
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

function clearCookie(secure: boolean): string {
  const attributes = [
    SESSION_COOKIE + "=",
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}
