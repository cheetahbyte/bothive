import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Db } from "./client.ts";

const migrationsFolder = new URL("../../drizzle", import.meta.url).pathname;

export function runMigrations(db: Db) {
  return migrate(db, { migrationsFolder });
}
