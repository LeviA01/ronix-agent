import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HttpError } from "./http.js";

export const USER_MODULES = ["chat", "learning", "development", "outline"] as const;
export type UserModule = typeof USER_MODULES[number];
export type AccessUser = {
  id: string;
  subject: string;
  username: string;
  name: string;
  role: "admin" | "user";
  disabled: boolean;
  modules: UserModule[];
  revision: number;
};
export type UserAccess = { modules: readonly UserModule[] };

export function requireModule(access: UserAccess | undefined, module: UserModule): void {
  if (access && !access.modules.includes(module)) throw new HttpError(403, "Нет доступа к модулю: " + module);
}

export function proxyIdentity(request: IncomingMessage, secret: string, trustedAddresses: string[]) {
  const address = (request.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  const supplied = request.headers["x-ronix-proxy-secret"];
  const expected = Buffer.from(secret);
  const actual = Buffer.from(typeof supplied === "string" ? supplied : "");
  if (!secret || !trustedAddresses.includes(address)
    || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new HttpError(401, "Требуется вход через Authentik");
  }
  const field = (key: string, required = false) => {
    const value = request.headers[key];
    if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\r\n\0]/.test(value)) {
      if (required) throw new HttpError(401, "Authentik не передал идентификатор пользователя");
      return "";
    }
    return value.trim();
  };
  return {
    subject: field("x-authentik-uid", true),
    username: field("x-authentik-username", true),
    name: field("x-authentik-name"),
  };
}

export class AccessStore {
  private readonly db: DatabaseSync;
  constructor(directory: string, private readonly adminSubjects: readonly string[]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, "access.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, subject TEXT NOT NULL UNIQUE, username TEXT NOT NULL,
        name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','user')),
        disabled INTEGER NOT NULL DEFAULT 0, modules TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1
      );
    `);
  }
  identify(identity: { subject: string; username: string; name: string }): AccessUser {
    const existing = this.db.prepare("SELECT id FROM users WHERE subject = ?").get(identity.subject);
    if (!existing) {
      const admin = this.adminSubjects.includes(identity.subject);
      this.db.prepare("INSERT INTO users(id,subject,username,name,role,modules) VALUES(?,?,?,?,?,?)")
        .run(randomUUID(), identity.subject, identity.username, identity.name,
          admin ? "admin" : "user", JSON.stringify(admin ? USER_MODULES : []));
    } else {
      this.db.prepare("UPDATE users SET username=?, name=? WHERE subject=?")
        .run(identity.username, identity.name, identity.subject);
    }
    return this.decode(this.db.prepare("SELECT * FROM users WHERE subject = ?").get(identity.subject)!);
  }
  list(): AccessUser[] {
    return this.db.prepare("SELECT * FROM users ORDER BY username").all().map(row => this.decode(row));
  }
  get(id: string): AccessUser {
    const row = this.db.prepare("SELECT * FROM users WHERE id=?").get(id);
    if (!row) throw new HttpError(404, "Пользователь не найден");
    return this.decode(row);
  }
  update(id: string, input: { role?: unknown; disabled?: unknown; modules?: unknown }): AccessUser {
    const current = this.get(id);
    const role = input.role ?? current.role;
    const disabled = input.disabled ?? current.disabled;
    const modules = input.modules ?? current.modules;
    if ((role !== "admin" && role !== "user") || typeof disabled !== "boolean"
      || !Array.isArray(modules) || modules.some(value => !USER_MODULES.includes(value))) {
      throw new HttpError(400, "Некорректные права пользователя");
    }
    if (current.role === "admin" && !current.disabled && (role !== "admin" || disabled)) {
      const row = this.db.prepare("SELECT count(*) AS count FROM users WHERE role='admin' AND disabled=0").get()!;
      if (Number(row.count) <= 1) throw new HttpError(409, "Нельзя отключить последнего администратора");
    }
    this.db.prepare("UPDATE users SET role=?, disabled=?, modules=?, revision=revision+1 WHERE id=?")
      .run(role, disabled ? 1 : 0, JSON.stringify([...new Set(modules)]), id);
    return this.get(id);
  }
  close(): void { this.db.close(); }
  private decode(row: Record<string, unknown>): AccessUser {
    return { id: String(row.id), subject: String(row.subject), username: String(row.username),
      name: String(row.name), role: row.role as AccessUser["role"], disabled: Boolean(row.disabled),
      modules: JSON.parse(String(row.modules)) as UserModule[], revision: Number(row.revision) };
  }
}
