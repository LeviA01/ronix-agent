import assert from "node:assert/strict";
import test from "node:test";
import {
  parseEnvFile,
  serializeEnvFile,
} from "../src/env-file.js";
import { moduleStatuses } from "../src/modules.js";
import {
  renderSystemdService,
  resolveProjectRoots,
} from "../src/setup.js";

test("serializes setup values without losing spaces or secrets", () => {
  const content = serializeEnvFile([
    ["PROJECT_ROOTS", "/srv/ronix projects,/home/user/code"],
    ["AGENT_KEY", "secret-with-#-and-quotes\""],
    ["TTS_ENABLED", "false"],
  ]);
  assert.deepEqual(parseEnvFile(content), {
    PROJECT_ROOTS: "/srv/ronix projects,/home/user/code",
    AGENT_KEY: "secret-with-#-and-quotes\"",
    TTS_ENABLED: "false",
  });
});

test("renders a systemd unit tied to the generated config and installation", () => {
  const unit = renderSystemdService({
    user: "ronix",
    appRoot: "/opt/ronix agent",
    configPath: "/etc/ronix/config.env",
    nodePath: "/usr/bin/node",
  });
  assert.match(unit, /User=ronix/);
  assert.match(unit, /WorkingDirectory=\/opt\/ronix\\x20agent/);
  assert.match(unit, /RONIX_CONFIG=\/etc\/ronix\/config\.env/);
  assert.match(unit, /dist\/src\/server\.js/);
  assert.match(unit, /NoNewPrivileges=true/);
  assert.match(unit, /UMask=0077/);
});

test("resolves short project folder names from the displayed project base", () => {
  assert.deepEqual(
    resolveProjectRoots(
      "RONIX, team, /srv/shared, RONIX,",
      "/home/ronix/Projects",
    ),
    [
      "/home/ronix/Projects/RONIX",
      "/home/ronix/Projects/team",
      "/srv/shared",
    ],
  );
  assert.throws(
    () => resolveProjectRoots("../private", "/home/ronix/Projects"),
    /выходит за базовый каталог/,
  );
});

test("keeps optional audio modules disabled unless fully configured", () => {
  assert.deepEqual(moduleStatuses({
    tts: { enabled: false, provider: null, endpoint: null },
    stt: {
      enabled: true,
      provider: "whisper",
      endpoint: "http://127.0.0.1:9000",
    },
  }), [
    { id: "tts", enabled: false, configured: false, provider: null },
    { id: "stt", enabled: true, configured: true, provider: "whisper" },
  ]);
});
