import { and, eq } from "drizzle-orm";
import { createSelectSchema } from "drizzle-zod";
import type { Db } from "../db/client.ts";
import { runs } from "../db/schema.ts";

export const runSchema = createSelectSchema(runs);

export type Run = typeof runs.$inferSelect;

export async function getRun(db: Db, userId: string, runId: string) {
  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.userId, userId)));
  return run ? runSchema.parse(run) : null;
}
