import { createApplication } from "./server.js";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import type { UserModule } from "./access.js";

const socket = process.env.RONIX_WORKER_SOCKET;
if (!socket) throw new Error("RONIX_WORKER_SOCKET is required");
const modules = JSON.parse(process.env.RONIX_USER_MODULES ?? "[]") as UserModule[];
const app = createApplication({ config, access: { modules },
  publicDir: fileURLToPath(new URL("../../public", import.meta.url)) });
app.server.listen(socket, () => process.stdout.write("RONIX_WORKER_READY\n"));
app.server.on("error", error => {
  console.error(error);
  void app.shutdown().finally(() => process.exit(1));
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void app.shutdown().finally(() => process.exit(0)));
}
