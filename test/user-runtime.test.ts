import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sandboxArguments } from "../src/user-runtime.js";

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
    } fs.writeFileSync(${JSON.stringify(join(root, "allowed"))},'ok');`;
    const result = spawnSync("bwrap", [...sandboxArguments(root, app, process.execPath), process.execPath, "-e", probe], { encoding: "utf8" });
    if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") { t.skip("bubblewrap is not installed"); return; }
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(root, "allowed"), "utf8"), "ok");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
