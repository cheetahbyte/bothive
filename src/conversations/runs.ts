import { and, desc, eq, isNull } from "drizzle-orm";
import { createSelectSchema } from "drizzle-zod";
import type { Db } from "../db/client.ts";
import { bots, runs } from "../db/schema.ts";
import { getBotAccessRole } from "../identity/bots.ts";

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

export async function listBotRuns(db: Db, userId: string, botId: string) {
  const role = await getBotAccessRole(db, userId, botId);
  if (!role) return null;

  return db
    .select({
      id: runs.id,
      jobId: runs.jobId,
      conversationId: runs.conversationId,
      userId: runs.userId,
      runtimeId: runs.runtimeId,
      attempt: runs.attempt,
      status: runs.status,
      failureReason: runs.failureReason,
      createdAt: runs.createdAt,
      finishedAt: runs.finishedAt,
    })
    .from(runs)
    .where(and(eq(runs.botId, botId), role === "member" ? eq(runs.userId, userId) : undefined))
    .orderBy(desc(runs.createdAt), desc(runs.id));
}
