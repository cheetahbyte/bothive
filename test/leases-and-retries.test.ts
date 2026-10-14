import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeRuntime } from "../src/runtime/fake.ts";
import { reapExpiredJobs } from "../src/worker/worker.ts";
import {
  createUserWithToken,
  db,
  request,
  spawnWorkerProcess,
  startTestWorker,
} from "./helpers.ts";

const validBot = {
  name: "Helper",
  runtimeId: "fake",
  runtimeSettings: { model: "test-model" },
};

async function createBotFor(
  user: { token: string },
  overrides?: {
    name?: string;
    runtimeId?: string;
    runtimeSettings?: Record<string, unknown>;
  },
) {
  const response = await request(user.token, "/bots", {
    ...validBot,
    ...overrides,
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; name: string };
}

async function waitForJob(
  token: string,
  jobId: string,
  timeoutMs = 10000,
): Promise<{
  id: string;
  status: string;
  attempt?: number;
  runId?: string | null;
  failureReason?: string | null;
}> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await request(token, `/jobs/${jobId}`);
    if (res.status === 200) {
      const job = (await res.json()) as {
        id: string;
        status: string;
        attempt?: number;
        runId?: string | null;
        failureReason?: string | null;
      };
      if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
        return job;
      }
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

describe("leases, retries and runtime failure handling", () => {
  beforeEach(() => {
    fakeRuntime.reset();
  });

  afterEach(() => {
    fakeRuntime.reset();
  });

  it("killing a worker mid-Run leads to the Job being retried after lease expiry and eventually succeeding", async () => {
    const alice = await createUserWithToken();
    const bot = await createBotFor(alice, {
      runtimeSettings: { delayMs: 1500 },
    });

    const workerProc = spawnWorkerProcess({
      WORKER_BOT_ID: bot.id,
      JOB_LEASE_DURATION_MS: "300",
      JOB_RENEW_INTERVAL_MS: "5000",
      JOB_BACKOFF_BASE_MS: "50",
    });

    try {
      const convRes = await request(alice.token, `/bots/${bot.id}/conversations`, {});
      const conv = (await convRes.json()) as { id: string };

      const msgRes = await request(alice.token, `/conversations/${conv.id}/messages`, {
        clientMessageId: `midrun-kill-${randomUUID()}`,
        content: "Please complete this work",
      });
      const msg = (await msgRes.json()) as { jobId: string };

      // Poll until the job is claimed by workerProc and running
      let isRunning = false;
      const start = Date.now();
      while (Date.now() - start < 5000) {
        const res = await request(alice.token, `/jobs/${msg.jobId}`);
        if (res.status === 200) {
          const job = (await res.json()) as { status: string; attempt?: number };
          if (job.status === "running") {
            isRunning = true;
            expect(job.attempt).toBe(1);
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(isRunning).toBe(true);

      // Abruptly kill the worker process mid-Run (SIGKILL so no shutdown handlers run)
      workerProc.process.kill("SIGKILL");

      // Configure fakeRuntime in-process for the replacement worker
      fakeRuntime.scriptBot(bot.id, { reply: "Echo: Please complete this work" });

      // Start replacement worker for this bot with fast settings
      const replacementWorker = startTestWorker({
        botId: bot.id,
        leaseDurationMs: 300,
        backoffBaseMs: 50,
      });

      try {
        const job = await waitForJob(alice.token, msg.jobId, 10000);
        expect(job.status).toBe("succeeded");
        expect(job.attempt).toBe(2);

        const msgsRes = await request(alice.token, `/conversations/${conv.id}/messages`);
        const msgs = (await msgsRes.json()) as Array<{ content: string; botId: string | null }>;
        expect(msgs).toHaveLength(2);
        expect(msgs[1]?.botId).toBe(bot.id);
        expect(msgs[1]?.content).toBe("Echo: Please complete this work");
      } finally {
        await replacementWorker.stop();
      }
    } finally {
      try {
        workerProc.process.kill("SIGKILL");
      } catch {
        // Process may already be dead
      }
    }
  });

  it("a Job whose lease keeps expiring ends failed with reason lease_expired after the maximum attempts", async () => {
    const alice = await createUserWithToken();
    const bot = await createBotFor(alice, {
      runtimeSettings: { delayMs: 1500 },
    });

    const convRes = await request(alice.token, `/bots/${bot.id}/conversations`, {});
    const conv = (await convRes.json()) as { id: string };

    const msgRes = await request(alice.token, `/conversations/${conv.id}/messages`, {
      clientMessageId: `expire-test-${randomUUID()}`,
      content: "Will keep expiring",
    });
    const msg = (await msgRes.json()) as { jobId: string };

    // Perform 3 claims by workers that are killed mid-Run
    for (let attempt = 1; attempt <= 3; attempt++) {
      const proc = spawnWorkerProcess({
        WORKER_BOT_ID: bot.id,
        JOB_LEASE_DURATION_MS: "150",
        JOB_RENEW_INTERVAL_MS: "5000",
        JOB_BACKOFF_BASE_MS: "30",
        JOB_MAX_ATTEMPTS: "3",
      });

      try {
        let isRunning = false;
        const start = Date.now();
        while (Date.now() - start < 5000) {
          const res = await request(alice.token, `/jobs/${msg.jobId}`);
          if (res.status === 200) {
            const job = (await res.json()) as { status: string; attempt?: number };
            if (job.status === "running" && job.attempt === attempt) {
              isRunning = true;
              break;
            }
          }
          await new Promise((r) => setTimeout(r, 20));
        }
        expect(isRunning).toBe(true);
      } finally {
        proc.process.kill("SIGKILL");
      }

      // Wait for the lease to expire (150ms + margin)
      await new Promise((r) => setTimeout(r, 200));

      // Trigger reaper for this bot to either re-queue with backoff or fail on 3rd attempt
      await reapExpiredJobs(db, {
        botId: bot.id,
        maxAttempts: 3,
        backoffBaseMs: 30,
      });

      if (attempt < 3) {
        // Wait out the backoff so the next attempt is eligible
        const backoffMs = 30 * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, backoffMs + 50));
      }
    }

    const job = await waitForJob(alice.token, msg.jobId, 5000);
    expect(job.status).toBe("failed");
    expect(job.failureReason).toBe("lease_expired");
    expect(job.attempt).toBe(3);
  });

  it("a worker that lost its lease cannot commit a reply or a Job transition; the newer attempt's result wins", async () => {
    const alice = await createUserWithToken();
    const bot = await createBotFor(alice);

    // Attempt 1 will delay for 350ms before returning a stale reply
    // Attempt 2 will return the winning reply immediately
    fakeRuntime
      .scriptBot(bot.id, {
        delayMs: 350,
        reply: "Stale reply from attempt 1",
      })
      .scriptBot(bot.id, {
        reply: "Winning reply from attempt 2",
      });

    const convRes = await request(alice.token, `/bots/${bot.id}/conversations`, {});
    const conv = (await convRes.json()) as { id: string };

    const msgRes = await request(alice.token, `/conversations/${conv.id}/messages`, {
      clientMessageId: `fencing-test-${randomUUID()}`,
      content: "Fencing test message",
    });
    const msg = (await msgRes.json()) as { jobId: string };

    // Worker 1: Short lease duration (120ms) and high renew interval (10000ms), so its lease expires mid-run
    const worker1 = startTestWorker({
      botId: bot.id,
      leaseDurationMs: 120,
      renewIntervalMs: 10_000,
      backoffBaseMs: 20,
    });

    // Wait until Worker 1 has claimed the job
    let worker1Claimed = false;
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const res = await request(alice.token, `/jobs/${msg.jobId}`);
      if (res.status === 200) {
        const job = (await res.json()) as { status: string; attempt?: number };
        if (job.status === "running" && job.attempt === 1) {
          worker1Claimed = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(worker1Claimed).toBe(true);

    // Wait until Worker 1's lease expires (120ms + margin)
    await new Promise((r) => setTimeout(r, 160));

    // Worker 2 starts, reaps the expired lease, claims attempt 2, and completes immediately
    const worker2 = startTestWorker({
      botId: bot.id,
      leaseDurationMs: 1000,
      renewIntervalMs: 100,
      backoffBaseMs: 20,
    });

    try {
      // Wait for Worker 2 to succeed
      const job = await waitForJob(alice.token, msg.jobId, 5000);
      expect(job.status).toBe("succeeded");
      expect(job.attempt).toBe(2);

      // Now wait for Worker 1's delay (350ms total) to elapse so it tries to commit with stale lease
      await new Promise((r) => setTimeout(r, 250));

      // Assert that Worker 2's result won: job is still succeeded with attempt 2
      const jobAfterStale = (await (await request(alice.token, `/jobs/${msg.jobId}`)).json()) as {
        status: string;
        attempt: number;
        runId: string;
      };
      expect(jobAfterStale.status).toBe("succeeded");
      expect(jobAfterStale.attempt).toBe(2);
      expect(jobAfterStale.runId).toBe(job.runId);

      // And conversation has only the winning reply from attempt 2
      const msgsRes = await request(alice.token, `/conversations/${conv.id}/messages`);
      const msgs = (await msgsRes.json()) as Array<{ content: string; botId: string | null }>;
      expect(msgs).toHaveLength(2);
      expect(msgs[1]?.botId).toBe(bot.id);
      expect(msgs[1]?.content).toBe("Winning reply from attempt 2");
    } finally {
      await worker1.stop();
      await worker2.stop();
    }
  });

  it("a hanging runtime is aborted at its time limit and the attempt is recorded as failed", async () => {
    const alice = await createUserWithToken();
    const bot = await createBotFor(alice);

    fakeRuntime.scriptBot(bot.id, { hang: true });

    const worker = startTestWorker({
      botId: bot.id,
      runTimeoutMs: 150,
      pollIntervalMs: 20,
    });

    try {
      const convRes = await request(alice.token, `/bots/${bot.id}/conversations`, {});
      const conv = (await convRes.json()) as { id: string };

      const msgRes = await request(alice.token, `/conversations/${conv.id}/messages`, {
        clientMessageId: `timeout-test-${randomUUID()}`,
        content: "Will hang forever",
      });
      const msg = (await msgRes.json()) as { jobId: string };

      const job = await waitForJob(alice.token, msg.jobId, 5000);
      expect(job.status).toBe("failed");
      expect(job.failureReason).toBe("run_timeout");
      expect(typeof job.runId).toBe("string");

      const runRes = await request(alice.token, `/runs/${job.runId!}`);
      expect(runRes.status).toBe(200);
      const run = (await runRes.json()) as {
        status: string;
        failureReason: string;
      };
      expect(run.status).toBe("failed");
      expect(run.failureReason).toBe("run_timeout");

      const msgsRes = await request(alice.token, `/conversations/${conv.id}/messages`);
      const msgs = (await msgsRes.json()) as Array<{ content: string }>;
      expect(msgs).toHaveLength(1);
    } finally {
      await worker.stop();
    }
  });

  it("retryable runtime failures are retried with backoff; the attempt number is visible on the Job", async () => {
    const alice = await createUserWithToken();
    const bot = await createBotFor(alice);

    fakeRuntime
      .scriptBot(bot.id, {
        fail: "rate limit exceeded",
        retryable: true,
      })
      .scriptBot(bot.id, {
        reply: "Recovered after retryable failure",
      });

    const worker = startTestWorker({
      botId: bot.id,
      backoffBaseMs: 150,
      maxAttempts: 3,
      pollIntervalMs: 20,
    });

    try {
      const convRes = await request(alice.token, `/bots/${bot.id}/conversations`, {});
      const conv = (await convRes.json()) as { id: string };

      const msgRes = await request(alice.token, `/conversations/${conv.id}/messages`, {
        clientMessageId: `retry-test-${randomUUID()}`,
        content: "Trigger retry",
      });
      const msg = (await msgRes.json()) as { jobId: string };

      // Poll until attempt 1 has failed and returned to queued with backoff
      let sawQueuedAttempt1 = false;
      const start = Date.now();
      while (Date.now() - start < 3000) {
        const res = await request(alice.token, `/jobs/${msg.jobId}`);
        if (res.status === 200) {
          const job = (await res.json()) as {
            status: string;
            attempt: number;
            failureReason: string | null;
          };
          if (job.status === "queued" && job.attempt === 1) {
            sawQueuedAttempt1 = true;
            expect(job.failureReason).toBe("rate limit exceeded");
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(sawQueuedAttempt1).toBe(true);

      // Now wait for backoff (150ms) to pass and attempt 2 to succeed
      const job = await waitForJob(alice.token, msg.jobId, 5000);
      expect(job.status).toBe("succeeded");
      expect(job.attempt).toBe(2);

      const msgsRes = await request(alice.token, `/conversations/${conv.id}/messages`);
      const msgs = (await msgsRes.json()) as Array<{ content: string; botId: string | null }>;
      expect(msgs).toHaveLength(2);
      expect(msgs[1]?.botId).toBe(bot.id);
      expect(msgs[1]?.content).toBe("Recovered after retryable failure");
    } finally {
      await worker.stop();
    }
  });

  it("retryable runtime failures stop retrying and fail after maximum attempts", async () => {
    const alice = await createUserWithToken();
    const bot = await createBotFor(alice);

    fakeRuntime
      .scriptBot(bot.id, { fail: "rate limit 1", retryable: true })
      .scriptBot(bot.id, { fail: "rate limit 2", retryable: true })
      .scriptBot(bot.id, { fail: "rate limit 3", retryable: true });

    const worker = startTestWorker({
      botId: bot.id,
      backoffBaseMs: 30,
      maxAttempts: 3,
      pollIntervalMs: 15,
    });

    try {
      const convRes = await request(alice.token, `/bots/${bot.id}/conversations`, {});
      const conv = (await convRes.json()) as { id: string };

      const msgRes = await request(alice.token, `/conversations/${conv.id}/messages`, {
        clientMessageId: `max-retries-${randomUUID()}`,
        content: "Trigger max retries",
      });
      const msg = (await msgRes.json()) as { jobId: string };

      const job = await waitForJob(alice.token, msg.jobId, 5000);
      expect(job.status).toBe("failed");
      expect(job.failureReason).toBe("rate limit 3");
      expect(job.attempt).toBe(3);

      const msgsRes = await request(alice.token, `/conversations/${conv.id}/messages`);
      const msgs = (await msgsRes.json()) as Array<{ content: string }>;
      expect(msgs).toHaveLength(1);
    } finally {
      await worker.stop();
    }
  });
});
