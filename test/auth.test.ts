import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { AuthManager } from "../src/auth.js";

function request(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

function response(): ServerResponse & { headers: Map<string, string> } {
  const headers = new Map<string, string>();
  return {
    headers,
    setHeader(name: string, value: number | string | readonly string[]) {
      headers.set(name.toLowerCase(), String(value));
      return this;
    },
  } as unknown as ServerResponse & { headers: Map<string, string> };
}

test("creates an HttpOnly cookie session and supports logout", () => {
  const auth = new AuthManager("a".repeat(64), 60_000, true);
  const loginResponse = response();

  assert.deepEqual(auth.login(loginResponse, "a".repeat(64), "client"), { ok: true });
  const setCookie = loginResponse.headers.get("set-cookie");
  assert.ok(setCookie?.includes("ronix_session="));
  assert.ok(setCookie?.includes("HttpOnly"));
  assert.ok(setCookie?.includes("SameSite=Strict"));
  assert.ok(setCookie?.includes("Secure"));

  const cookie = setCookie?.split(";", 1)[0] ?? "";
  const authenticatedRequest = request({ cookie });
  assert.equal(auth.authorized(authenticatedRequest), true);

  const logoutResponse = response();
  auth.logout(authenticatedRequest, logoutResponse);
  assert.equal(auth.authorized(authenticatedRequest), false);
  assert.ok(logoutResponse.headers.get("set-cookie")?.includes("Max-Age=0"));
});

test("accepts the configured key as a bearer token", () => {
  const key = "b".repeat(64);
  const auth = new AuthManager(key, 60_000, true);
  assert.equal(auth.authorized(request({ authorization: "Bearer " + key })), true);
  assert.equal(auth.authorized(request({ authorization: "Bearer wrong" })), false);
});

test("rate limits repeated invalid login attempts", () => {
  const auth = new AuthManager("c".repeat(64), 60_000, true);
  for (let attempt = 1; attempt < 5; attempt += 1) {
    assert.deepEqual(auth.login(response(), "wrong", "client"), { ok: false });
  }
  const blocked = auth.login(response(), "wrong", "client");
  assert.equal(blocked.ok, false);
  assert.ok(!blocked.ok && blocked.retryAfterSeconds && blocked.retryAfterSeconds > 0);
});

test("authentication is bypassed when no key is configured", () => {
  const auth = new AuthManager("", 60_000, false);
  assert.equal(auth.authorized(request()), true);
  assert.deepEqual(auth.login(response(), "", "client"), { ok: true });
});
