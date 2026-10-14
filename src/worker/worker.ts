import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Job } from "../conversations/jobs.ts";
import type { Db } from "../db/client.ts";
import { bots, conversations, jobs, messages, runs } from "../db/schema.ts";
import type { RuntimeRegistry } from "../runtime/registry.ts";

export type WorkerOptions = {
  workerId?: string;
  pollIntervalMs?: number;
  botId?: string;
  leaseDurationMs?: number;
  renewIntervalMs?: number;
  backoffBaseMs?: number;
  maxAttempts?: number;
  runTimeoutMs?: number;
};

export type ReaperOptions = {
  maxAttempts?: number;
  backoffBaseMs?: number;
  botId?: string;
};

const releasedLease = { leaseOwner: null, leaseToken: null, leaseExpiresAt: null };

function holdsLease(job: Job) {
  return and(
    eq(jobs.id, job.id),
    eq(jobs.status, "running"),
    eq(jobs.leaseToken, job.leaseToken!),
    sql`${jobs.leaseExpiresAt} > NOW()`,
  );
}

export async function reapExpiredJobs(db: Db, options: ReaperOptions = {}): Promise<number> {
  const maxAttempts = options.maxAttempts ?? 3;
  const backoffBaseMs = options.backoffBaseMs ?? 1_000;

  return db.transaction(async (tx) => {
    const expired = await tx
      .select({
        id: jobs.id,
        attempt: jobs.attempt,
      })
      .from(jobs)
      .innerJoin(conversations, eq(conversations.id, jobs.conversationId))
      .where(
        and(
          eq(jobs.status, "running"),
          sql`${jobs.leaseExpiresAt} IS NOT NULL`,
          sql`${jobs.leaseExpiresAt} <= NOW()`,
          ...(options.botId ? [eq(conversations.botId, options.botId)] : []),
        ),
      )
      .for("update", { skipLocked: true });

    if (expired.length === 0) return 0;

    for (const job of expired) {
      if (job.attempt >= maxAttempts) {
        await tx
          .update(jobs)
          .set({
            status: "failed",
            failureReason: "lease_expired",
            ...releasedLease,
          })
          .where(eq(jobs.id, job.id));
      } else {
        const backoffMs = backoffBaseMs * Math.pow(2, Math.max(0, job.attempt - 1));

        await tx
          .update(jobs)
          .set({
            status: "queued",
            ...releasedLease,
            nextEligibleAt: sql`NOW() + (${backoffMs} || ' milliseconds')::interval`,
          })
          .where(eq(jobs.id, job.id));
      }
    }

    return expired.length;
  });
}

export class Worker {
  readonly id: string;
  private db: Db;
  private registry: RuntimeRegistry;
  private options: Required<Omit<WorkerOptions, "botId">> & { botId?: string };
  private stopped = false;
  private runningLoop: Promise<void> | null = null;
  private wakeUpSleep: (() => void) | null = null;
  private activeControllers = new Set<AbortController>();

  constructor(db: Db, registry: RuntimeRegistry, options: WorkerOptions = {}) {
    this.db = db;
    this.registry = registry;
    this.id = options.workerId ?? randomUUID();
    this.options = {
      workerId: this.id,
      pollIntervalMs: options.pollIntervalMs ?? 100,
      botId: options.botId,
      leaseDurationMs: options.leaseDurationMs ?? 30_000,
      renewIntervalMs: options.renewIntervalMs ?? 10_000,
      backoffBaseMs: options.backoffBaseMs ?? 1_000,
      maxAttempts: options.maxAttempts ?? 3,
      runTimeoutMs: options.runTimeoutMs ?? 60_000,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeUpSleep = null;
        resolve();
      }, ms);
      this.wakeUpSleep = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  async reapExpiredJobs(): Promise<number> {
    return reapExpiredJobs(this.db, {
      maxAttempts: this.options.maxAttempts,
      backoffBaseMs: this.options.backoffBaseMs,
      botId: this.options.botId,
    });
  }

  async claimJob(): Promise<Job | "rejected" | null> {
    return this.db.transaction(async (tx) => {
      const [claimed] = await tx
        .select({ id: jobs.id, disabledAt: bots.disabledAt, deletedAt: bots.deletedAt })
        .from(jobs)
        .innerJoin(conversations, eq(conversations.id, jobs.conversationId))
        .innerJoin(bots, eq(bots.id, conversations.botId))
        .where(
          and(
            eq(jobs.status, "queued"),
            sql`${jobs.nextEligibleAt} <= NOW()`,
            ...(this.options.botId ? [eq(conversations.botId, this.options.botId)] : []),
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

      const leaseToken = randomUUID();

      const [job] = await tx
        .update(jobs)
        .set({
          status: "running",
          attempt: sql`${jobs.attempt} + 1`,
          leaseOwner: this.id,
          leaseToken,
          leaseExpiresAt: sql`NOW() + (${this.options.leaseDurationMs} || ' milliseconds')::interval`,
        })
        .where(eq(jobs.id, claimed.id))
        .returning();

      return job ?? null;
    });
  }

  private async failClaimedJob(job: Job, failureReason: string) {
    await this.db
      .update(jobs)
      .set({ status: "failed", failureReason, ...releasedLease })
      .where(holdsLease(job));
  }

  async runOnce(): Promise<boolean> {
    await this.reapExpiredJobs();

    const job = await this.claimJob();
    if (!job) return false;
    if (job === "rejected") return true;

    const [conversation] = await this.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, job.conversationId));

    if (!conversation) {
      await this.failClaimedJob(job, "conversation_not_found");
      return true;
    }

    const [bot] = await this.db.select().from(bots).where(eq(bots.id, conversation.botId));

    if (!bot) {
      await this.failClaimedJob(job, "bot_not_found");
      return true;
    }

    const runtime = this.registry.get(bot.runtimeId);
    if (!runtime) {
      await this.db.transaction(async (tx) => {
        const [currentJob] = await tx.select().from(jobs).where(holdsLease(job)).for("update");

        if (!currentJob) return;

        const [run] = await tx
          .insert(runs)
          .values({
            jobId: job.id,
            conversationId: job.conversationId,
            userId: job.userId,
            botId: bot.id,
            runtimeId: bot.runtimeId,
            status: "failed",
            failureReason: "runtime_unavailable",
            finishedAt: new Date(),
          })
          .returning();

        await tx
          .update(jobs)
          .set({
            status: "failed",
            runId: run!.id,
            failureReason: "runtime_unavailable",
            ...releasedLease,
          })
          .where(eq(jobs.id, job.id));
      });
      return true;
    }

    const convMessages = await this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, job.conversationId))
      .orderBy(messages.createdAt, messages.id);

    const abortController = new AbortController();
    this.activeControllers.add(abortController);

    let timedOut = false;
    let timeoutTimer: NodeJS.Timeout | null = null;
    if (this.options.runTimeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        abortController.abort(new Error("run_timeout"));
      }, this.options.runTimeoutMs);
    }

    let lostLease = false;
    let renewTimer: NodeJS.Timeout | null = null;
    if (this.options.renewIntervalMs > 0) {
      renewTimer = setInterval(async () => {
        try {
          const updated = await this.db
            .update(jobs)
            .set({
              leaseExpiresAt: sql`NOW() + (${this.options.leaseDurationMs} || ' milliseconds')::interval`,
            })
            .where(holdsLease(job))
            .returning({ id: jobs.id });

          if (updated.length === 0) {
            lostLease = true;
            abortController.abort(new Error("lease_lost"));
            if (renewTimer) clearInterval(renewTimer);
          }
        } catch (renewError) {
          console.error("Worker failed to renew lease:", renewError);
        }
      }, this.options.renewIntervalMs);
    }

    let completed = false;
    let failedEvent: { reason: string; retryable?: boolean } | null = null;
    let outputText = "";
    let usage: Record<string, unknown> = {};

    try {
      const stream = runtime.execute(
        {
          bot,
          conversation,
          job,
          messages: convMessages,
        },
        abortController.signal,
      );

      for await (const event of stream) {
        if (event.type === "output_text") {
          outputText += event.text;
        } else if (event.type === "usage") {
          usage = { ...usage, ...event.usage };
        } else if (event.type === "completed") {
          completed = true;
        } else if (event.type === "failed") {
          failedEvent = {
            reason: event.error ?? event.reason ?? "runtime_failed",
            retryable: event.retryable ?? false,
          };
          break;
        }
      }
    } catch (error) {
      if (timedOut) {
        failedEvent = { reason: "run_timeout", retryable: false };
      } else if (lostLease) {
        failedEvent = { reason: "lease_lost", retryable: false };
      } else {
        const retryable = Boolean(
          error && typeof error === "object" && "retryable" in error && error.retryable,
        );
        failedEvent = {
          reason: error instanceof Error ? error.message : String(error),
          retryable,
        };
      }
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (renewTimer) clearInterval(renewTimer);
      this.activeControllers.delete(abortController);
    }

    if (timedOut && !failedEvent) {
      failedEvent = { reason: "run_timeout", retryable: false };
    } else if (lostLease && !failedEvent) {
      failedEvent = { reason: "lease_lost", retryable: false };
    } else if (!completed && !failedEvent) {
      failedEvent = { reason: "stream_ended_without_completion", retryable: false };
    }

    try {
      await this.db.transaction(async (tx) => {
        const [currentJob] = await tx.select().from(jobs).where(holdsLease(job)).for("update");

        if (!currentJob) {
          return;
        }

        if (failedEvent) {
          const [run] = await tx
            .insert(runs)
            .values({
              jobId: job.id,
              conversationId: job.conversationId,
              userId: job.userId,
              botId: bot.id,
              runtimeId: bot.runtimeId,
              status: "failed",
              usage,
              failureReason: failedEvent.reason,
              finishedAt: new Date(),
            })
            .returning();

          if (failedEvent.retryable && currentJob.attempt < this.options.maxAttempts) {
            const backoffMs =
              this.options.backoffBaseMs * Math.pow(2, Math.max(0, currentJob.attempt - 1));

            await tx
              .update(jobs)
              .set({
                status: "queued",
                runId: run!.id,
                failureReason: failedEvent.reason,
                ...releasedLease,
                nextEligibleAt: sql`NOW() + (${backoffMs} || ' milliseconds')::interval`,
              })
              .where(eq(jobs.id, job.id));
          } else {
            await tx
              .update(jobs)
              .set({
                status: "failed",
                runId: run!.id,
                failureReason: failedEvent.reason,
                ...releasedLease,
              })
              .where(eq(jobs.id, job.id));
          }
        } else {
          const [run] = await tx
            .insert(runs)
            .values({
              jobId: job.id,
              conversationId: job.conversationId,
              userId: job.userId,
              botId: bot.id,
              runtimeId: bot.runtimeId,
              status: "succeeded",
              usage,
              failureReason: null,
              finishedAt: new Date(),
            })
            .returning();

          await tx.insert(messages).values({
            conversationId: job.conversationId,
            botId: bot.id,
            userId: null,
            clientMessageId: null,
            content: outputText,
            jobId: job.id,
          });

          await tx
            .update(jobs)
            .set({
              status: "succeeded",
              runId: run!.id,
              failureReason: null,
              ...releasedLease,
            })
            .where(eq(jobs.id, job.id));
        }
      });
    } catch (commitError) {
      console.error("Worker failed to commit job transition:", commitError);
      throw commitError;
    }

    return true;
  }

  start(): Promise<void> {
    if (this.runningLoop) return this.runningLoop;
    this.stopped = false;
    this.runningLoop = this.loop();
    return this.runningLoop;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const processed = await this.runOnce();
        if (!processed && !this.stopped) {
          await this.sleep(this.options.pollIntervalMs);
        }
      } catch (loopError) {
        console.error("Worker loop encountered error:", loopError);
        if (!this.stopped) {
          await this.sleep(this.options.pollIntervalMs);
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wakeUpSleep?.();
    for (const controller of this.activeControllers) {
      controller.abort();
    }
    if (this.runningLoop) {
      await this.runningLoop;
      this.runningLoop = null;
    }
  }
}

export function createWorker(db: Db, registry: RuntimeRegistry, options?: WorkerOptions): Worker {
  return new Worker(db, registry, options);
}
