import { randomUUID } from "node:crypto";
import { and, eq, type SQL, sql } from "drizzle-orm";
import type { Job } from "../conversations/jobs.ts";
import type { Db } from "../db/client.ts";
import { bots, conversations, jobs, messages, runs, users } from "../db/schema.ts";
import { getBotAccessRole, type Bot } from "../identity/bots.ts";
import type { RuntimeUsage } from "../runtime/types.ts";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

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

async function failRun(tx: Tx, runId: string, failureReason: string) {
  await tx
    .update(runs)
    .set({ status: "failed", failureReason, finishedAt: new Date() })
    .where(eq(runs.id, runId));
}

export async function reapExpiredJobs(db: Db, policy: RetryPolicy, botId?: string) {
  return db.transaction(async (tx) => {
    const expired = await tx
      .select({ id: jobs.id, attempt: jobs.attempt, runId: jobs.runId })
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
      if (job.runId) await failRun(tx, job.runId, "lease_expired");
    }
    return expired.length;
  });
}

export type ClaimOptions = {
  workerId: string;
  leaseDurationMs: number;
  userConcurrencyLimit: number;
  botId?: string;
};

type Candidate = { id: string; conversationId: string; userId: string; botId: string };

// Running Jobs that count against a candidate's Conversation, Bot and User limits.
function runningFor(candidate: { conversationId: SQL; botId: SQL; userId: SQL }) {
  return sql`(
    SELECT
      count(*) FILTER (WHERE r.conversation_id = ${candidate.conversationId})::int AS conversation,
      count(*) FILTER (WHERE c.bot_id = ${candidate.botId})::int AS bot,
      count(*) FILTER (WHERE r.user_id = ${candidate.userId})::int AS user
    FROM ${jobs} r
    JOIN ${conversations} c ON c.id = r.conversation_id
    WHERE r.status = 'running'
  )`;
}

async function findCandidate(tx: Tx, options: ClaimOptions): Promise<Candidate | undefined> {
  const running = runningFor({
    conversationId: sql`${jobs.conversationId}`,
    botId: sql`${conversations.botId}`,
    userId: sql`${jobs.userId}`,
  });
  const [candidate] = await tx
    .select({
      id: jobs.id,
      conversationId: jobs.conversationId,
      userId: jobs.userId,
      botId: conversations.botId,
    })
    .from(jobs)
    .innerJoin(conversations, eq(conversations.id, jobs.conversationId))
    .innerJoin(bots, eq(bots.id, conversations.botId))
    .where(
      and(
        eq(jobs.status, "queued"),
        sql`${jobs.nextEligibleAt} <= NOW()`,
        ...forBot(options.botId),
        // Message order: an earlier queued Job of the same Conversation goes first, even in backoff.
        sql`NOT EXISTS (
          SELECT 1 FROM ${jobs} earlier
          WHERE earlier.conversation_id = ${jobs.conversationId}
            AND earlier.status = 'queued'
            AND (earlier.created_at, earlier.id) < (${jobs.createdAt}, ${jobs.id})
        )`,
        sql`(SELECT conversation = 0 FROM ${running} counts)`,
        sql`(SELECT bot < ${bots.concurrencyLimit} FROM ${running} counts)`,
        sql`(SELECT "user" < ${options.userConcurrencyLimit} FROM ${running} counts)`,
      ),
    )
    .orderBy(jobs.createdAt, jobs.id)
    .limit(1)
    .for("update", { of: jobs, skipLocked: true });
  return candidate;
}

export async function claimJob(db: Db, options: ClaimOptions): Promise<Job | "rejected" | null> {
  return db.transaction(async (tx) => {
    const candidate = await findCandidate(tx, options);
    if (!candidate) return null;

    // Locking the User, then the Bot, serializes competing claims so the recount below is exact.
    await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, candidate.userId))
      .for("update");
    const [bot] = await tx
      .select({
        runtimeId: bots.runtimeId,
        concurrencyLimit: bots.concurrencyLimit,
        disabledAt: bots.disabledAt,
        deletedAt: bots.deletedAt,
      })
      .from(bots)
      .where(eq(bots.id, candidate.botId))
      .for("update");

    if (!bot || bot.deletedAt || bot.disabledAt) {
      await tx
        .update(jobs)
        .set({ status: "failed", failureReason: bot?.disabledAt ? "bot_disabled" : "bot_deleted" })
        .where(eq(jobs.id, candidate.id));
      return "rejected";
    }

    if (!(await getBotAccessRole(tx, candidate.userId, candidate.botId))) {
      await tx
        .update(jobs)
        .set({ status: "failed", failureReason: "revoked" })
        .where(eq(jobs.id, candidate.id));
      return "rejected";
    }

    const [counts] = await tx
      .execute<{ conversation: number; bot: number; user: number }>(
        sql`SELECT * FROM ${runningFor({
          conversationId: sql`${candidate.conversationId}::uuid`,
          botId: sql`${candidate.botId}::uuid`,
          userId: sql`${candidate.userId}::uuid`,
        })} counts`,
      )
      .then((result) => result.rows);
    if (
      !counts ||
      counts.conversation > 0 ||
      counts.bot >= bot.concurrencyLimit ||
      counts.user >= options.userConcurrencyLimit
    ) {
      return null;
    }

    const runId = randomUUID();
    const [job] = await tx
      .update(jobs)
      .set({
        status: "running",
        attempt: sql`${jobs.attempt} + 1`,
        leaseOwner: options.workerId,
        leaseToken: randomUUID(),
        leaseExpiresAt: fromNow(options.leaseDurationMs),
        runId,
      })
      .where(eq(jobs.id, candidate.id))
      .returning();
    if (!job) return null;

    await tx.insert(runs).values({
      id: runId,
      jobId: job.id,
      conversationId: job.conversationId,
      userId: job.userId,
      botId: candidate.botId,
      runtimeId: bot.runtimeId,
      attempt: job.attempt,
      status: "running",
    });
    return job;
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
  await db.transaction(async (tx) => {
    const [released] = await tx
      .update(jobs)
      .set({
        status: "queued",
        attempt: sql`GREATEST(0, ${jobs.attempt} - 1)`,
        ...releasedLease,
        nextEligibleAt: sql`NOW()`,
      })
      .where(holdsLease(job))
      .returning({ runId: jobs.runId });
    if (released?.runId) await failRun(tx, released.runId, "lease_expired");
  });
}

export async function failJob(db: Db, job: Job, failureReason: string) {
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(jobs)
      .set({ status: "failed", failureReason, ...releasedLease })
      .where(holdsLease(job))
      .returning({ runId: jobs.runId });
    if (updated?.runId) await failRun(tx, updated.runId, failureReason);
  });
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

    // Revoked during the Run: the reply is discarded and the Job fails without retry.
    const effective: RunOutcome = (await getBotAccessRole(tx, job.userId, bot.id))
      ? outcome
      : { status: "failed", reason: "revoked", retryable: false, usage: outcome.usage };

    const failureReason = effective.status === "failed" ? effective.reason : null;
    await tx
      .update(runs)
      .set({
        status: effective.status,
        usage: effective.usage,
        failureReason,
        finishedAt: new Date(),
      })
      .where(eq(runs.id, current.runId!));
    const transition = { failureReason, ...releasedLease };

    if (effective.status === "succeeded") {
      await tx.insert(messages).values({
        conversationId: job.conversationId,
        botId: bot.id,
        content: effective.text,
        jobId: job.id,
      });
      await tx
        .update(jobs)
        .set({ status: "succeeded", ...transition })
        .where(eq(jobs.id, job.id));
    } else if (effective.retryable && current.attempt < policy.maxAttempts) {
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
