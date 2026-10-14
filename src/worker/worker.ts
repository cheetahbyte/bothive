import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Job } from "../conversations/jobs.ts";
import type { Db } from "../db/client.ts";
import { bots, conversations, jobs, messages, runs } from "../db/schema.ts";
import type { RuntimeRegistry } from "../runtime/registry.ts";

export type WorkerOptions = {
  workerId?: string;
  pollIntervalMs?: number;
  botId?: string;
};

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

  async claimJob(): Promise<Job | null> {
    return this.db.transaction(async (tx) => {
      const [claimed] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .innerJoin(conversations, eq(conversations.id, jobs.conversationId))
        .where(
          this.options.botId
            ? and(eq(jobs.status, "queued"), eq(conversations.botId, this.options.botId))
            : eq(jobs.status, "queued"),
        )
        .orderBy(jobs.createdAt)
        .limit(1)
        .for("update", { skipLocked: true });

      if (!claimed) return null;

      const [job] = await tx
        .update(jobs)
        .set({ status: "running" })
        .where(eq(jobs.id, claimed.id))
        .returning();

      return job ?? null;
    });
  }

  async runOnce(): Promise<boolean> {
    const job = await this.claimJob();
    if (!job) return false;

    const [conversation] = await this.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, job.conversationId));

    if (!conversation) {
      await this.db
        .update(jobs)
        .set({ status: "failed", failureReason: "conversation_not_found" })
        .where(eq(jobs.id, job.id));
      return true;
    }

    const [bot] = await this.db.select().from(bots).where(eq(bots.id, conversation.botId));

    if (!bot) {
      await this.db
        .update(jobs)
        .set({ status: "failed", failureReason: "bot_not_found" })
        .where(eq(jobs.id, job.id));
      return true;
    }

    const runtime = this.registry.get(bot.runtimeId);
    if (!runtime) {
      await this.db.transaction(async (tx) => {
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

    let completed = false;
    let failedEvent: { reason: string } | null = null;
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
          failedEvent = { reason: event.error ?? event.reason ?? "runtime_failed" };
          break;
        }
      }
    } catch (error) {
      failedEvent = { reason: error instanceof Error ? error.message : String(error) };
    } finally {
      this.activeControllers.delete(abortController);
    }

    if (!completed && !failedEvent) {
      failedEvent = { reason: "stream_ended_without_completion" };
    }

    try {
      await this.db.transaction(async (tx) => {
        const [currentJob] = await tx
          .select()
          .from(jobs)
          .where(and(eq(jobs.id, job.id), eq(jobs.status, "running")))
          .for("update");

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

          await tx
            .update(jobs)
            .set({
              status: "failed",
              runId: run!.id,
              failureReason: failedEvent.reason,
            })
            .where(eq(jobs.id, job.id));
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
