import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeRuntime } from "../src/runtime/fake.ts";
import { createUserWithToken, request, spawnWorkerProcess, startTestWorker } from "./helpers.ts";

const validBot = {
  name: "Helper",
  runtimeId: "fake",
  runtimeSettings: { model: "test-model" },
};

async function createBotFor(user: { token: string }, overrides?: Partial<typeof validBot>) {
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
  timeoutMs = 5000,
): Promise<{ id: string; status: string; runId?: string | null; failureReason?: string | null }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await request(token, `/jobs/${jobId}`);
    if (res.status === 200) {
      const job = (await res.json()) as {
        id: string;
        status: string;
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

describe("execution with fake Agent runtime", () => {
  beforeEach(() => {
    fakeRuntime.reset();
  });

  afterEach(() => {
    fakeRuntime.reset();
  });

  it("with one worker running, a posted message eventually gets a reply attributed to the Bot and records a Run", async () => {
    const alice = await createUserWithToken();
    const bot = await createBotFor(alice);
    const worker = startTestWorker({ botId: bot.id });

    try {
      const convRes = await request(alice.token, `/bots/${bot.id}/conversations`, {});
      expect(convRes.status).toBe(201);
      const conv = (await convRes.json()) as { id: string };

      const msgRes = await request(alice.token, `/conversations/${conv.id}/messages`, {
        clientMessageId: "msg-1",
        content: "What is the status?",
      });
      expect(msgRes.status).toBe(201);
      const userMsg = (await msgRes.json()) as { id: string; jobId: string };

      const job = await waitForJob(alice.token, userMsg.jobId);
      expect(job.status).toBe("succeeded");
      expect(typeof job.runId).toBe("string");

      const msgsRes = await request(alice.token, `/conversations/${conv.id}/messages`);
      expect(msgsRes.status).toBe(200);
      const msgs = (await msgsRes.json()) as Array<{
        id: string;
        botId: string | null;
        userId: string | null;
        content: string;
        jobId: string;
      }>;
      expect(msgs).toHaveLength(2);

      const [firstMsg, replyMsg] = msgs;
      expect(firstMsg?.id).toBe(userMsg.id);
      expect(typeof firstMsg?.userId).toBe("string");
      expect(firstMsg?.botId).toBeNull();

      expect(replyMsg?.botId).toBe(bot.id);
      expect(replyMsg?.userId).toBeNull();
      expect(replyMsg?.jobId).toBe(userMsg.jobId);
      expect(replyMsg?.content).toBe("Echo: What is the status?");

      const runRes = await request(alice.token, `/runs/${job.runId!}`);
      expect(runRes.status).toBe(200);
      const run = (await runRes.json()) as {
        id: string;
        jobId: string;
        runtimeId: string;
        status: string;
        usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
      };
      expect(run.id).toBe(job.runId);
      expect(run.jobId).toBe(userMsg.jobId);
      expect(run.runtimeId).toBe("fake");
      expect(run.status).toBe("succeeded");
      expect(run.usage).toEqual({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      });
    } finally {
      await worker.stop();
    }
  });

  it("Runs are private: another User cannot read the Run and malformed IDs return 404", async () => {
    const alice = await createUserWithToken();
    const bob = await createUserWithToken();
    const bot = await createBotFor(alice);
    const worker = startTestWorker({ botId: bot.id });

    try {
      const conv = (await (
        await request(alice.token, `/bots/${bot.id}/conversations`, {})
      ).json()) as { id: string };

      const postRes = await request(alice.token, `/conversations/${conv.id}/messages`, {
        clientMessageId: "privacy-test-msg",
        content: "Private work",
      });
      const posted = (await postRes.json()) as { jobId: string };

      const job = await waitForJob(alice.token, posted.jobId);
      expect(job.status).toBe("succeeded");

      const gotBob = await request(bob.token, `/runs/${job.runId!}`);
      expect(gotBob.status).toBe(404);

      const malformed = await request(alice.token, "/runs/not-a-uuid");
      expect(malformed.status).toBe(404);

      const randomId = await request(alice.token, `/runs/${randomUUID()}`);
      expect(randomId.status).toBe(404);
    } finally {
      await worker.stop();
    }
  });

  it("fake runtime can be scripted per test to reply with custom text and emit usage", async () => {
    const alice = await createUserWithToken();
    const bot = await createBotFor(alice);
    fakeRuntime.scriptBot(bot.id, {
      reply: "Scripted answer",
      usage: { promptTokens: 100, completionTokens: 25, totalTokens: 125 },
    });

    const worker = startTestWorker({ botId: bot.id });
    try {
      const conv = (await (
        await request(alice.token, `/bots/${bot.id}/conversations`, {})
      ).json()) as { id: string };

      const msg = (await (
        await request(alice.token, `/conversations/${conv.id}/messages`, {
          clientMessageId: "script-1",
          content: "Hello?",
        })
      ).json()) as { jobId: string };

      const job = await waitForJob(alice.token, msg.jobId);
      expect(job.status).toBe("succeeded");

      const run = (await (await request(alice.token, `/runs/${job.runId!}`)).json()) as {
        status: string;
        usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
      };
      expect(run.status).toBe("succeeded");
      expect(run.usage).toEqual({
        promptTokens: 100,
        completionTokens: 25,
        totalTokens: 125,
      });

      const msgs = (await (
        await request(alice.token, `/conversations/${conv.id}/messages`)
      ).json()) as Array<{ content: string; botId: string | null }>;
      expect(msgs[1]?.content).toBe("Scripted answer");
      expect(msgs[1]?.botId).toBe(bot.id);
    } finally {
      await worker.stop();
    }
  });

  it("a stream that ends without a completed event is recorded as a failed Run, not a success", async () => {
    const alice = await createUserWithToken();
    const bot = await createBotFor(alice);
    fakeRuntime.scriptBot(bot.id, { endEarly: true });

    const worker = startTestWorker({ botId: bot.id });
    try {
      const conv = (await (
        await request(alice.token, `/bots/${bot.id}/conversations`, {})
      ).json()) as { id: string };

      const msg = (await (
        await request(alice.token, `/conversations/${conv.id}/messages`, {
          clientMessageId: "early-end-msg",
          content: "Will it finish?",
        })
      ).json()) as { jobId: string };

      const job = await waitForJob(alice.token, msg.jobId);
      expect(job.status).toBe("failed");
      expect(job.failureReason).toBe("stream_ended_without_completion");

      const run = (await (await request(alice.token, `/runs/${job.runId!}`)).json()) as {
        status: string;
        failureReason: string;
      };
      expect(run.status).toBe("failed");
      expect(run.failureReason).toBe("stream_ended_without_completion");

      const msgs = (await (
        await request(alice.token, `/conversations/${conv.id}/messages`)
      ).json()) as Array<{ content: string }>;
      expect(msgs).toHaveLength(1);
    } finally {
      await worker.stop();
    }
  });

  it("a scripted runtime failure ends the Job as failed with a reason", async () => {
    const alice = await createUserWithToken();
    const bot = await createBotFor(alice);
    fakeRuntime.scriptBot(bot.id, { fail: "model rate limited" });

    const worker = startTestWorker({ botId: bot.id });
    try {
      const conv = (await (
        await request(alice.token, `/bots/${bot.id}/conversations`, {})
      ).json()) as { id: string };

      const msg = (await (
        await request(alice.token, `/conversations/${conv.id}/messages`, {
          clientMessageId: "fail-msg",
          content: "Trigger failure",
        })
      ).json()) as { jobId: string };

      const job = await waitForJob(alice.token, msg.jobId);
      expect(job.status).toBe("failed");
      expect(job.failureReason).toBe("model rate limited");

      const run = (await (await request(alice.token, `/runs/${job.runId!}`)).json()) as {
        status: string;
        failureReason: string;
      };
      expect(run.status).toBe("failed");
      expect(run.failureReason).toBe("model rate limited");

      const msgs = (await (
        await request(alice.token, `/conversations/${conv.id}/messages`)
      ).json()) as Array<{ content: string }>;
      expect(msgs).toHaveLength(1);
    } finally {
      await worker.stop();
    }
  });

  it("fake runtime hangs until aborted when worker stops", async () => {
    let sawAbortSignal = false;
    const alice = await createUserWithToken();
    const bot = await createBotFor(alice);

    fakeRuntime.scriptBot(bot.id, {
      hang: true,
      onExecute: (signal) => {
        signal.addEventListener(
          "abort",
          () => {
            sawAbortSignal = true;
          },
          { once: true },
        );
      },
    });

    const conv = (await (
      await request(alice.token, `/bots/${bot.id}/conversations`, {})
    ).json()) as { id: string };

    const msg = (await (
      await request(alice.token, `/conversations/${conv.id}/messages`, {
        clientMessageId: "hang-msg",
        content: "Hang test",
      })
    ).json()) as { jobId: string };

    const worker = startTestWorker({ botId: bot.id });

    // Poll until Job transitions to running
    const start = Date.now();
    let isRunning = false;
    while (Date.now() - start < 5000) {
      const res = await request(alice.token, `/jobs/${msg.jobId}`);
      if (res.status === 200) {
        const job = (await res.json()) as { status: string };
        if (job.status === "running") {
          isRunning = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(isRunning).toBe(true);

    // Stop worker and assert runtime received abort signal
    await worker.stop();
    expect(sawAbortSignal).toBe(true);
  });

  it("a child process worker answers messages correctly", async () => {
    const alice = await createUserWithToken();
    const bot = await createBotFor(alice);
    const workerProc = spawnWorkerProcess({ WORKER_BOT_ID: bot.id });

    try {
      const conv = (await (
        await request(alice.token, `/bots/${bot.id}/conversations`, {})
      ).json()) as { id: string };

      const msg = (await (
        await request(alice.token, `/conversations/${conv.id}/messages`, {
          clientMessageId: "proc-test-msg",
          content: "Hello worker process!",
        })
      ).json()) as { jobId: string };

      const job = await waitForJob(alice.token, msg.jobId);
      expect(job.status).toBe("succeeded");

      const msgs = (await (
        await request(alice.token, `/conversations/${conv.id}/messages`)
      ).json()) as Array<{ content: string; botId: string | null }>;
      expect(msgs).toHaveLength(2);
      expect(msgs[1]?.botId).toBe(bot.id);
      expect(msgs[1]?.content).toBe("Echo: Hello worker process!");
    } finally {
      await workerProc.stop();
    }
  });
});
