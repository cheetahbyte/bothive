import { loadConfig } from "../config.ts";
import { createDb } from "../db/client.ts";
import { fakeRuntime } from "../runtime/fake.ts";
import { createRuntimeRegistry } from "../runtime/registry.ts";
import { createWorker } from "./worker.ts";

const config = loadConfig(process.env);
const { db, close } = createDb(config.DATABASE_URL);

// Milestone 1 ships no real runtime; the fake one keeps the Compose stack answering.
const registry = createRuntimeRegistry([fakeRuntime]);

const worker = createWorker(db, registry, {
  botId: config.WORKER_BOT_ID,
});
console.log("Worker started");
void worker.start();

function shutdown() {
  void worker
    .stop()
    .then(() => close())
    .then(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
