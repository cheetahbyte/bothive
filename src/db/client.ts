import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.ts";

export function createDb(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  // A dropped connection (e.g. a PostgreSQL restart) must not crash the process: pg emits an
  // unhandled error on idle and checked-out clients alike, and the pool replaces them.
  const logDropped = (error: Error) => console.error("PostgreSQL connection lost:", error.message);
  pool.on("error", logDropped);
  pool.on("connect", (client) => client.on("error", logDropped));
  const db = drizzle(pool, { schema, casing: "snake_case" });
  let closing: Promise<void> | null = null;
  return { db, close: () => (closing ??= pool.end()) };
}

export type Db = ReturnType<typeof createDb>["db"];
