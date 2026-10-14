import { and, eq } from "drizzle-orm";
import { createSelectSchema } from "drizzle-zod";
import type { Db } from "../db/client.ts";
import { jobs } from "../db/schema.ts";

export const jobSchema = createSelectSchema(jobs);

export type Job = typeof jobs.$inferSelect;

export async function getJob(db: Db, userId: string, jobId: string) {
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.userId, userId)));
  return job ? jobSchema.parse(job) : null;
}
