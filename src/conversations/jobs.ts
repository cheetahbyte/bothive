import { and, eq, isNull } from "drizzle-orm";
import { createSelectSchema } from "drizzle-zod";
import type { Db } from "../db/client.ts";
import { accessGrants, bots, conversations, jobs } from "../db/schema.ts";

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
