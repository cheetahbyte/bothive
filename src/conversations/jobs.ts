import { and, desc, eq, isNull } from "drizzle-orm";
import { createSelectSchema } from "drizzle-zod";
import type { Db } from "../db/client.ts";
import { accessGrants, bots, conversations, jobs } from "../db/schema.ts";
import { getBotAccessRole } from "../identity/bots.ts";

export const jobSchema = createSelectSchema(jobs);

export type Job = typeof jobs.$inferSelect;

export async function getJob(db: Db, userId: string, jobId: string) {
  const [row] = await db
    .select({ job: jobs })
    .from(jobs)
    .innerJoin(conversations, eq(conversations.id, jobs.conversationId))
    .innerJoin(bots, eq(bots.id, conversations.botId))
    .innerJoin(
      accessGrants,
      and(eq(accessGrants.botId, conversations.botId), eq(accessGrants.userId, jobs.userId)),
    )
    .where(and(eq(jobs.id, jobId), eq(jobs.userId, userId), isNull(bots.deletedAt)));
  return row ? jobSchema.parse(row.job) : null;
}

export async function listBotJobs(db: Db, userId: string, botId: string) {
  const role = await getBotAccessRole(db, userId, botId);
  if (!role) return null;

  return db
    .select({
      id: jobs.id,
      conversationId: jobs.conversationId,
      userId: jobs.userId,
      status: jobs.status,
      attempt: jobs.attempt,
      runId: jobs.runId,
      failureReason: jobs.failureReason,
      nextEligibleAt: jobs.nextEligibleAt,
      createdAt: jobs.createdAt,
    })
    .from(jobs)
    .innerJoin(conversations, eq(conversations.id, jobs.conversationId))
    .where(
      and(eq(conversations.botId, botId), role === "member" ? eq(jobs.userId, userId) : undefined),
    )
    .orderBy(desc(jobs.createdAt), desc(jobs.id));
}
