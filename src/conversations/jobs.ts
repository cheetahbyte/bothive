import { and, eq } from "drizzle-orm";
import { createSelectSchema } from "drizzle-zod";
import type { Db } from "../db/client.ts";
import { accessGrants, conversations, jobs } from "../db/schema.ts";

export const jobSchema = createSelectSchema(jobs);

export type Job = typeof jobs.$inferSelect;

export async function getJob(db: Db, userId: string, jobId: string) {
  const [row] = await db
    .select({ job: jobs })
    .from(jobs)
    .innerJoin(conversations, eq(conversations.id, jobs.conversationId))
    .innerJoin(
      accessGrants,
      and(eq(accessGrants.botId, conversations.botId), eq(accessGrants.userId, jobs.userId)),
    )
    .where(and(eq(jobs.id, jobId), eq(jobs.userId, userId)));
  return row ? jobSchema.parse(row.job) : null;
}
