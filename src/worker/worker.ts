import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Job } from "../conversations/jobs.ts";
import type { Db } from "../db/client.ts";
import { bots, conversations, messages } from "../db/schema.ts";
import type { RuntimeRegistry } from "../runtime/registry.ts";
import type { AgentRuntime, RunRequest, RuntimeEvent, RuntimeUsage } from "../runtime/types.ts";
import {
  claimJob,
  failJob,
  finishJob,
  reapExpiredJobs,
  releaseJob,
  renewLease,
  type RunOutcome,
} from "./queue.ts";

export type WorkerOptions = {
  workerId?: string;
  pollIntervalMs?: number;
  botId?: string;
  leaseDurationMs?: number;
  renewIntervalMs?: number;
  backoffBaseMs?: number;
  maxAttempts?: number;
  runTimeoutMs?: number;
  shutdownTimeoutMs?: number;
};

type AbortReason = "run_timeout" | "lease_lost" | "shutdown";

type InFlight = { job: Job; abort: AbortController; done: Promise<void> };

function failed(reason: string, usage: RuntimeUsage, retryable = false): RunOutcome {
  return { status: "failed", reason, retryable, usage };
}

function isRetryable(error: unknown) {
  return typeof error === "object" && error !== null && "retryable" in error && !!error.retryable;
}

async function collectOutcome(
  stream: AsyncIterable<RuntimeEvent>,
  signal: AbortSignal,
): Promise<RunOutcome> {
  let text = "";
  let usage: RuntimeUsage = {};
  let completed = false;
  try {
    for await (const event of stream) {
      if (event.type === "output_text") text += event.text;
      else if (event.type === "usage") usage = { ...usage, ...event.usage };
      else if (event.type === "completed") completed = true;
      else {
        return failed(
          event.error ?? event.reason ?? "runtime_failed",
          usage,
          event.retryable ?? false,
        );
      }
    }
  } catch (error) {
    if (signal.aborted) return failed(String(signal.reason), usage);
    return failed(
      error instanceof Error ? error.message : String(error),
      usage,
      isRetryable(error),
    );
  }
  if (signal.aborted) return failed(String(signal.reason), usage);
  if (!completed) return failed("stream_ended_without_completion", usage);
  return { status: "succeeded", text, usage };
}

function settlesWithin(promise: Promise<unknown>, ms: number) {
  if (ms <= 0) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const settle = () => {
      clearTimeout(timer);
      resolve(true);
    };
    promise.then(settle, settle);
  });
}

export class Worker {
  readonly id: string;
  private readonly db: Db;
  private readonly registry: RuntimeRegistry;
  private readonly options: Required<Omit<WorkerOptions, "botId">> & { botId?: string };
  private stopped = false;
  private loopDone: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private inFlight: InFlight | null = null;

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
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 10_000,
    };
  }

  async runOnce(): Promise<boolean> {
    if (this.stopped) return false;
    await reapExpiredJobs(this.db, this.options, this.options.botId);
    if (this.stopped) return false;

    const job = await claimJob(this.db, this.options);
    if (!job) return false;
    if (job === "rejected") return true;

    const abort = new AbortController();
    const done = this.process(job, abort);
    this.inFlight = { job, abort, done };
    try {
      await done;
    } finally {
      this.inFlight = null;
    }
    return true;
  }

  private async process(job: Job, abort: AbortController) {
    const [row] = await this.db
      .select({ bot: bots, conversation: conversations })
      .from(conversations)
      .innerJoin(bots, eq(bots.id, conversations.botId))
      .where(eq(conversations.id, job.conversationId));
    if (!row) {
      await failJob(this.db, job, "bot_not_found");
      return;
    }

    const runtime = this.registry.get(row.bot.runtimeId);
    const outcome = runtime
      ? await this.execute(runtime, { ...row, job, messages: await this.history(job) }, abort)
      : failed("runtime_unavailable", {});
    await finishJob(this.db, job, row.bot, outcome, this.options);
  }

  private history(job: Job) {
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, job.conversationId))
      .orderBy(messages.createdAt, messages.id);
  }

  private async execute(runtime: AgentRuntime, request: RunRequest, abort: AbortController) {
    const stop = (reason: AbortReason) => abort.abort(reason);
    const timeout = setTimeout(() => stop("run_timeout"), this.options.runTimeoutMs);
    const renewal = setInterval(() => {
      renewLease(this.db, request.job, this.options.leaseDurationMs).then(
        (held) => held || stop("lease_lost"),
        (error: unknown) => console.error("Worker failed to renew lease:", error),
      );
    }, this.options.renewIntervalMs);
    try {
      return await collectOutcome(runtime.execute(request, abort.signal), abort.signal);
    } finally {
      clearTimeout(timeout);
      clearInterval(renewal);
    }
  }

  start(): Promise<void> {
    if (this.loopDone) return this.loopDone;
    this.stopped = false;
    this.stopping = null;
    this.loopDone = this.loop();
    return this.loopDone;
  }

  private async loop() {
    while (!this.stopped) {
      let processed = false;
      try {
        processed = await this.runOnce();
      } catch (error) {
        console.error("Worker loop error:", error);
      }
      if (!processed && !this.stopped) await this.sleep(this.options.pollIntervalMs);
    }
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  stop(): Promise<void> {
    this.stopping ??= this.shutdown();
    return this.stopping;
  }

  private async shutdown() {
    this.stopped = true;
    this.wake?.();
    const current = this.inFlight;
    if (current && !(await settlesWithin(current.done, this.options.shutdownTimeoutMs))) {
      // Release before aborting so the aborted attempt's commit is fenced off.
      await releaseJob(this.db, current.job).catch((error: unknown) =>
        console.error("Worker failed to release job on shutdown:", error),
      );
      current.abort.abort("shutdown" satisfies AbortReason);
    }
    await this.loopDone;
    this.loopDone = null;
  }
}

export function createWorker(db: Db, registry: RuntimeRegistry, options?: WorkerOptions): Worker {
  return new Worker(db, registry, options);
}
