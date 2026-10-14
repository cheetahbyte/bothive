import { and, eq, isNull } from "drizzle-orm";
import { createSelectSchema } from "drizzle-zod";
import type { Db } from "../db/client.ts";
import { bots, runs } from "../db/schema.ts";

export const runSchema = createSelectSchema(runs);

export type Run = typeof runs.$inferSelect;

export async function getRun(db: Db, userId: string, runId: string) {
  const [row] = await db
    .select({ run: runs })
    .from(runs)
    .innerJoin(bots, eq(bots.id, runs.botId))
    .where(and(eq(runs.id, runId), eq(runs.userId, userId), isNull(bots.deletedAt)));
  return row ? runSchema.parse(row.run) : null;
}
