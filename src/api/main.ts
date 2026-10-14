import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { loadConfig } from "../config.ts";
import { createDb } from "../db/client.ts";
import { fakeRuntime } from "../runtime/fake.ts";
import { createRuntimeRegistry } from "../runtime/registry.ts";
import { createApp } from "./app.ts";

const config = loadConfig(process.env);
const { db, close } = createDb(config.DATABASE_URL);

const registry = createRuntimeRegistry([fakeRuntime]);

const server = createServer(getRequestListener(createApp(db, registry).fetch));
server.listen(config.PORT, () => console.log(`API listening on port ${config.PORT}`));

let shuttingDown: Promise<void> | null = null;

function shutdown() {
  shuttingDown ??= new Promise<void>((resolve) => {
    const force = setTimeout(() => server.closeAllConnections(), config.SHUTDOWN_TIMEOUT_MS);
    server.close(() => {
      clearTimeout(force);
      resolve();
    });
    server.closeIdleConnections();
  })
    .then(close)
    .then(
      () => process.exit(0),
      (error: unknown) => {
        console.error("API shutdown failed:", error);
        process.exit(1);
      },
    );
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
