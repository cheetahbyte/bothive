import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Job } from "../conversations/jobs.ts";
import type { Db } from "../db/client.ts";
import { bots, conversations, jobs, messages, runs } from "../db/schema.ts";
import type { Bot } from "../identity/bots.ts";
import type { RuntimeUsage } from "../runtime/types.ts";

export type RetryPolicy = { maxAttempts: number; backoffBaseMs: number };

export type RunOutcome =
  | { status: "succeeded"; text: string; usage: RuntimeUsage }
  | { status: "failed"; reason: string; retryable: boolean; usage: RuntimeUsage };

const releasedLease = { leaseOwner: null, leaseToken: null, leaseExpiresAt: null };

function fromNow(ms: number) {
  return sql`NOW() + ${ms}::int * INTERVAL '1 millisecond'`;
}

function backoffMs(policy: RetryPolicy, attempt: number) {
  return policy.backoffBaseMs * 2 ** Math.max(0, attempt - 1);
}

function forBot(botId: string | undefined) {
  return botId ? [eq(conversations.botId, botId)] : [];
}

function holdsLease(job: Job) {
  return and(
    eq(jobs.id, job.id),
    eq(jobs.status, "running"),
    eq(jobs.leaseToken, job.leaseToken!),
    sql`${jobs.leaseExpiresAt} > NOW()`,
  );
}

export async function reapExpiredJobs(db: Db, policy: RetryPolicy, botId?: string) {
  return db.transaction(async (tx) => {
    const expired = await tx
      .select({ id: jobs.id, attempt: jobs.attempt })
      .from(jobs)
      .innerJoin(conversations, eq(conversations.id, jobs.conversationId))
      .where(
        and(eq(jobs.status, "running"), sql`${jobs.leaseExpiresAt} <= NOW()`, ...forBot(botId)),
      )
      .for("update", { of: jobs, skipLocked: true });

    for (const job of expired) {
      await tx
        .update(jobs)
        .set(
          job.attempt >= policy.maxAttempts
            ? { status: "failed", failureReason: "lease_expired", ...releasedLease }
            : {
                status: "queued",
                ...releasedLease,
                nextEligibleAt: fromNow(backoffMs(policy, job.attempt)),
              },
        )
        .where(eq(jobs.id, job.id));
    }
    return expired.length;
  });
}

export type ClaimOptions = { workerId: string; leaseDurationMs: number; botId?: string };

export async function claimJob(db: Db, options: ClaimOptions): Promise<Job | "rejected" | null> {
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .select({ id: jobs.id, disabledAt: bots.disabledAt, deletedAt: bots.deletedAt })
      .from(jobs)
      .innerJoin(conversations, eq(conversations.id, jobs.conversationId))
      .innerJoin(bots, eq(bots.id, conversations.botId))
      .where(
        and(
          eq(jobs.status, "queued"),
          sql`${jobs.nextEligibleAt} <= NOW()`,
          ...forBot(options.botId),
        ),
      )
      .orderBy(jobs.createdAt)
      .limit(1)
      .for("update", { of: jobs, skipLocked: true });

    if (!claimed) return null;

    if (claimed.deletedAt || claimed.disabledAt) {
      await tx
        .update(jobs)
        .set({
          status: "failed",
          failureReason: claimed.deletedAt ? "bot_deleted" : "bot_disabled",
        })
        .where(eq(jobs.id, claimed.id));
      return "rejected";
    }

    const [job] = await tx
      .update(jobs)
      .set({
        status: "running",
        attempt: sql`${jobs.attempt} + 1`,
        leaseOwner: options.workerId,
        leaseToken: randomUUID(),
        leaseExpiresAt: fromNow(options.leaseDurationMs),
      })
      .where(eq(jobs.id, claimed.id))
      .returning();
    return job ?? null;
  });
}

export async function renewLease(db: Db, job: Job, leaseDurationMs: number) {
  const renewed = await db
    .update(jobs)
    .set({ leaseExpiresAt: fromNow(leaseDurationMs) })
    .where(holdsLease(job))
    .returning({ id: jobs.id });
  return renewed.length > 0;
}

// A released attempt never ran to an outcome, so it does not count towards the maximum.
export async function releaseJob(db: Db, job: Job) {
  await db
    .update(jobs)
    .set({
      status: "queued",
      attempt: sql`GREATEST(0, ${jobs.attempt} - 1)`,
      ...releasedLease,
      nextEligibleAt: sql`NOW()`,
    })
    .where(holdsLease(job));
}

export async function failJob(db: Db, job: Job, failureReason: string) {
  await db
    .update(jobs)
    .set({ status: "failed", failureReason, ...releasedLease })
    .where(holdsLease(job));
}

export async function finishJob(
  db: Db,
  job: Job,
  bot: Bot,
  outcome: RunOutcome,
  policy: RetryPolicy,
) {
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(jobs).where(holdsLease(job)).for("update");
    if (!current) return;

    const failureReason = outcome.status === "failed" ? outcome.reason : null;
    const [run] = await tx
      .insert(runs)
      .values({
        jobId: job.id,
        conversationId: job.conversationId,
        userId: job.userId,
        botId: bot.id,
        runtimeId: bot.runtimeId,
        status: outcome.status,
        usage: outcome.usage,
        failureReason,
        finishedAt: new Date(),
      })
      .returning({ id: runs.id });
    const transition = { runId: run!.id, failureReason, ...releasedLease };

    if (outcome.status === "succeeded") {
      await tx.insert(messages).values({
        conversationId: job.conversationId,
        botId: bot.id,
        content: outcome.text,
        jobId: job.id,
      });
      await tx
        .update(jobs)
        .set({ status: "succeeded", ...transition })
        .where(eq(jobs.id, job.id));
    } else if (outcome.retryable && current.attempt < policy.maxAttempts) {
      await tx
        .update(jobs)
        .set({
          status: "queued",
          ...transition,
          nextEligibleAt: fromNow(backoffMs(policy, current.attempt)),
        })
        .where(eq(jobs.id, job.id));
    } else {
      await tx
        .update(jobs)
        .set({ status: "failed", ...transition })
        .where(eq(jobs.id, job.id));
    }
  });
}
