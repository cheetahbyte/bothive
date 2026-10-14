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
  leaseDurationMs: config.JOB_LEASE_DURATION_MS,
  renewIntervalMs: config.JOB_RENEW_INTERVAL_MS,
  backoffBaseMs: config.JOB_BACKOFF_BASE_MS,
  maxAttempts: config.JOB_MAX_ATTEMPTS,
  runTimeoutMs: config.RUN_TIMEOUT_MS,
  shutdownTimeoutMs: config.SHUTDOWN_TIMEOUT_MS,
});
console.log("Worker started");
void worker.start();

let shuttingDown: Promise<void> | null = null;

function shutdown() {
  shuttingDown ??= worker
    .stop()
    .then(close)
    .then(
      () => process.exit(0),
      (error: unknown) => {
        console.error("Worker shutdown failed:", error);
        process.exit(1);
      },
    );
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
