import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.ts";

export function createDb(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  const db = drizzle(pool, { schema, casing: "snake_case" });
  return { db, close: () => pool.end() };
}

export type Db = ReturnType<typeof createDb>["db"];
