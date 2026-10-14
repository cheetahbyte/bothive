import { serve } from "@hono/node-server";
import { loadConfig } from "../config.ts";
import { createDb } from "../db/client.ts";
import { createApp } from "./app.ts";

const config = loadConfig(process.env);
const { db, close } = createDb(config.DATABASE_URL);

const server = serve({ fetch: createApp(db).fetch, port: config.PORT });
console.log(`API listening on port ${config.PORT}`);

function shutdown() {
  server.close(() => void close().then(() => process.exit(0)));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
