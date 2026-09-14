import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sandboxArguments, outlineRuntimeAuth } from "../src/user-runtime.js";

test("sandbox mounts only the selected user's files and excludes application secrets", t => {
  const dir = mkdtempSync(join(tmpdir(), "ronix-jail-"));
  try {
    const root = join(dir, "alice"); mkdirSync(root);
    const privateFile = join(dir, "bob-secret"); writeFileSync(privateFile, "private");
    const app = join(dir, "app"); mkdirSync(app);
    for (const child of ["dist", "public", "node_modules"]) mkdirSync(join(app, child));
    writeFileSync(join(app, "package.json"), "{}");
    writeFileSync(join(app, ".env"), "SECRET=private");
    const probe = `const fs=require('fs'); for (const p of ${JSON.stringify([privateFile, join(app, ".env"), "/etc/caddy/Caddyfile"])}) {
      if(fs.existsSync(p)) throw Error('Unexpected outside file: '+p);
    }
    const os = require('os');
    const assert = require('assert/strict');
    assert.equal(os.userInfo().uid, process.getuid());
    assert.equal(os.userInfo().gid, process.getgid());
    assert.equal(os.userInfo().homedir, ${JSON.stringify(join(root, "home"))});
    assert.equal(fs.readFileSync('/etc/passwd', 'utf8').trim().split('\\n').length, 1);
    const ssh = require('child_process').spawnSync('ssh', ['-G', 'git@example.com'], { encoding: 'utf8' });
    assert.equal(ssh.status, 0, ssh.stderr);
    assert.match(ssh.stdout, /user git/);
    fs.writeFileSync(${JSON.stringify(join(root, "allowed"))},'ok');`;
    const result = spawnSync("bwrap", [...sandboxArguments(root, app, process.execPath), process.execPath, "-e", probe], { encoding: "utf8" });
    if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") { t.skip("bubblewrap is not installed"); return; }
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(root, "allowed"), "utf8"), "ok");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("Outline file auth replaces stale bearer auth and remains confined to enabled users", () => {
  const dir = mkdtempSync(join(tmpdir(), "ronix-outline-auth-"));
  try {
    const root = join(dir, "alice"); mkdirSync(root);
    const keyFile = join(dir, "key"); writeFileSync(keyFile, "test-key", { mode: 0o600 });
    const helper = join(dir, "headers");
    writeFileSync(helper, '#!/usr/bin/node\nprocess.stdout.write(JSON.stringify({Authorization:"Bearer "+require("fs").readFileSync(' + JSON.stringify(keyFile) + ',"utf8")}));', { mode: 0o700 });
    const app = join(dir, "app"); mkdirSync(app);
    for (const name of ["dist", "public", "node_modules"]) mkdirSync(join(app, name));
    writeFileSync(join(app, "package.json"), "{}");
    const config = { outlineConfig: '[mcp_servers.outline] # shared\nurl = "https://example.test/mcp"\nbearer_token_env_var = "OUTLINE_API_KEY"\n[mcp_servers.other]\nbearer_token_env_var = "OTHER_KEY"\n',
      outlineApiKey: "stale-key", outlineFileAuth: { helper, keyFile } };
    const auth = outlineRuntimeAuth(["outline"], config);
    assert.match(auth.config, /http_headers_helper/);
    assert.doesNotMatch(auth.config, /OUTLINE_API_KEY/);
    assert.match(auth.config, /OTHER_KEY/);
    assert.deepEqual(auth.env, {});
    for (const enabled of [true, false]) {
      const current = outlineRuntimeAuth(enabled ? ["outline"] : ["chat"], config);
      const probe = enabled
        ? 'const h=JSON.parse(require("child_process").execFileSync(' + JSON.stringify(helper) + ',{encoding:"utf8"})); require("assert").equal(h.Authorization,"Bearer test-key"); require("assert").equal(process.env.OUTLINE_API_KEY,undefined);'
        : 'require("assert").equal(require("fs").existsSync(' + JSON.stringify(keyFile) + '),false);';
      const result = spawnSync("bwrap", [...sandboxArguments(root, app, process.execPath), ...current.mounts,
        "--setenv", "PATH", "/usr/bin:/bin", process.execPath, "-e", probe], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      if (!enabled) assert.equal(current.config, "");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
