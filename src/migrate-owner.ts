import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { AccessStore } from "./access.js";
import { config } from "./config.js";

// Offline migration: stop the old service before invoking this command.
const subject = process.env.RONIX_OWNER_SUBJECT;
const username = process.env.RONIX_OWNER_USERNAME;
const usersRoot = process.env.RONIX_USERS_DIR;
const accessRoot = process.env.RONIX_ACCESS_DIR;
const codexHome = process.env.RONIX_OWNER_CODEX_HOME;
if (!subject || !username || !usersRoot || !accessRoot || !codexHome) {
  throw new Error("Set RONIX_OWNER_SUBJECT, RONIX_OWNER_USERNAME, RONIX_OWNER_CODEX_HOME, RONIX_USERS_DIR and RONIX_ACCESS_DIR");
}
for (const path of [usersRoot, accessRoot]) {
  const rel = relative(config.dataDir, resolve(path));
  if (!rel.startsWith("../")) throw new Error("User and access directories must be outside the legacy DATA_DIR");
}
const access = new AccessStore(accessRoot, [subject]);
try {
  const owner = access.identify({ subject, username, name: username });
  const destination = join(resolve(usersRoot), owner.id);
  if (existsSync(join(destination, "data"))) throw new Error("Owner data already exists; refusing to overwrite it");
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  cpSync(config.dataDir, join(destination, "data"), { recursive: true, errorOnExist: true, force: false });
  const targetHome = join(destination, "codex"); mkdirSync(targetHome, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(codexHome)) {
    if (["sessions", "archived_sessions", "session_index.jsonl", "history.jsonl"].includes(name) || /\.sqlite(?:-wal|-shm)?$/.test(name)) {
      cpSync(join(codexHome, name), join(targetHome, name), { recursive: true, errorOnExist: true, force: false });
    }
  }
  console.log(`Owner data copied for ${username}; user ID: ${owner.id}. Original data is retained.`);
} finally { access.close(); }
