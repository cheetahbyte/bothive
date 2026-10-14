import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeRuntime } from "../src/runtime/fake.ts";
import { createUserWithToken, request, startTestWorker, waitForJob } from "./helpers.ts";

const validBot = {
  name: "ConcurrencyBot",
  runtimeId: "fake",
  runtimeSettings: { model: "test-model" },
};

async function createBotFor(
  user: { token: string },
  overrides?: {
    name?: string;
    runtimeId?: string;
    runtimeSettings?: Record<string, unknown>;
    concurrencyLimit?: number;
  },
) {
  const response = await request(user.token, "/bots", {
    ...validBot,
    ...overrides,
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; name: string; concurrencyLimit: number };
}

describe("concurrency limits and multiple workers", () => {
  beforeEach(() => {
    fakeRuntime.reset();
  });

  afterEach(() => {
    fakeRuntime.reset();
  });

  it("two workers process Jobs from different Conversations in parallel", async () => {
    const alice = await createUserWithToken();
    const bot = await createBotFor(alice, { concurrencyLimit: 4 });

    const convRes1 = await request(alice.token, `/bots/${bot.id}/conversations`, {});
    const conv1 = (await convRes1.json()) as { id: string };
    const convRes2 = await request(alice.token, `/bots/${bot.id}/conversations`, {});
    const conv2 = (await convRes2.json()) as { id: string };

    let releaseJob1: () => void = () => {};
    let releaseJob2: () => void = () => {};
    const gate1 = new Promise<void>((r) => {
      releaseJob1 = r;
    });
    const gate2 = new Promise<void>((r) => {
      releaseJob2 = r;
    });

    let job1Executing = false;
    let job2Executing = false;
    let bothInFlightAtSameTime = false;

    let resolveStarted1: () => void = () => {};
    let resolveStarted2: () => void = () => {};
    const started1 = new Promise<void>((r) => {
      resolveStarted1 = r;
    });
    const started2 = new Promise<void>((r) => {
      resolveStarted2 = r;
    });

    fakeRuntime
      .scriptBot(bot.id, {
        waitFor: gate1,
        reply: "Reply 1",
        onExecute: () => {
          job1Executing = true;
          if (job2Executing) bothInFlightAtSameTime = true;
          resolveStarted1();
        },
      })
      .scriptBot(bot.id, {
        waitFor: gate2,
        reply: "Reply 2",
        onExecute: () => {
          job2Executing = true;
          if (job1Executing) bothInFlightAtSameTime = true;
          resolveStarted2();
        },
      });

    const worker1 = startTestWorker({ botId: bot.id });
    const worker2 = startTestWorker({ botId: bot.id });

    try {
      const msgRes1 = await request(alice.token, `/conversations/${conv1.id}/messages`, {
        clientMessageId: `parallel-1-${randomUUID()}`,
        content: "Message 1",
      });
      const msg1 = (await msgRes1.json()) as { jobId: string };

      const msgRes2 = await request(alice.token, `/conversations/${conv2.id}/messages`, {
        clientMessageId: `parallel-2-${randomUUID()}`,
        content: "Message 2",
      });
      const msg2 = (await msgRes2.json()) as { jobId: string };

      await Promise.all([started1, started2]);

      expect(job1Executing).toBe(true);
      expect(job2Executing).toBe(true);
      expect(bothInFlightAtSameTime).toBe(true);

      releaseJob1();
      releaseJob2();

      await Promise.all([waitForJob(alice.token, msg1.jobId), waitForJob(alice.token, msg2.jobId)]);

      const list1Res = await request(alice.token, `/conversations/${conv1.id}/messages`);
      const list1 = (await list1Res.json()) as Array<{ content: string }>;
      expect(list1).toHaveLength(2);
      expect(list1[1]?.content).toBe("Reply 1");

      const list2Res = await request(alice.token, `/conversations/${conv2.id}/messages`);
      const list2 = (await list2Res.json()) as Array<{ content: string }>;
      expect(list2).toHaveLength(2);
      expect(list2[1]?.content).toBe("Reply 2");
    } finally {
      releaseJob1();
      releaseJob2();
      await Promise.all([worker1.stop(), worker2.stop()]);
    }
  });

  it("Jobs within one Conversation never run concurrently and are processed in message order, even with several workers", async () => {
    const alice = await createUserWithToken();
    const bot = await createBotFor(alice, { concurrencyLimit: 4 });

    const convRes = await request(alice.token, `/bots/${bot.id}/conversations`, {});
    const conv = (await convRes.json()) as { id: string };

    const executionLog: string[] = [];
    let releaseJob1: () => void = () => {};
    const gate1 = new Promise<void>((r) => {
      releaseJob1 = r;
    });

    let resolveStarted1: () => void = () => {};
    const started1 = new Promise<void>((r) => {
      resolveStarted1 = r;
    });

    fakeRuntime
      .scriptBot(bot.id, {
        waitFor: gate1,
        reply: "Echo: First",
        onExecute: () => {
          executionLog.push("job1_start");
          resolveStarted1();
        },
      })
      .scriptBot(bot.id, {
        reply: "Echo: Second",
        onExecute: () => {
          executionLog.push("job2_start");
        },
      });

    const worker1 = startTestWorker({ botId: bot.id });
    const worker2 = startTestWorker({ botId: bot.id });

    try {
      const msgRes1 = await request(alice.token, `/conversations/${conv.id}/messages`, {
        clientMessageId: `order-1-${randomUUID()}`,
        content: "First",
      });
      const msg1 = (await msgRes1.json()) as { jobId: string };

      const msgRes2 = await request(alice.token, `/conversations/${conv.id}/messages`, {
        clientMessageId: `order-2-${randomUUID()}`,
        content: "Second",
      });
      const msg2 = (await msgRes2.json()) as { jobId: string };

      await started1;
      expect(executionLog).toEqual(["job1_start"]);

      await new Promise((r) => setTimeout(r, 100));
      expect(executionLog).toEqual(["job1_start"]);

      releaseJob1();

      await waitForJob(alice.token, msg2.jobId);
      await waitForJob(alice.token, msg1.jobId);

      expect(executionLog).toEqual(["job1_start", "job2_start"]);

      const listRes = await request(alice.token, `/conversations/${conv.id}/messages`);
      const list = (await listRes.json()) as Array<{
        content: string;
        clientMessageId?: string | null;
      }>;
      expect(list).toHaveLength(4);
      expect(list[0]?.content).toBe("First");
      expect(list[1]?.content).toBe("Second");
      expect(list[2]?.content).toBe("Echo: First");
      expect(list[3]?.content).toBe("Echo: Second");
    } finally {
      releaseJob1();
      await Promise.all([worker1.stop(), worker2.stop()]);
    }
  });

  it("the per-Bot limit caps concurrent running Jobs for that Bot across all workers", async () => {
    const alice = await createUserWithToken();
    const bot = await createBotFor(alice, { concurrencyLimit: 2 });

    const convRes1 = await request(alice.token, `/bots/${bot.id}/conversations`, {});
    const conv1 = (await convRes1.json()) as { id: string };
    const convRes2 = await request(alice.token, `/bots/${bot.id}/conversations`, {});
    const conv2 = (await convRes2.json()) as { id: string };
    const convRes3 = await request(alice.token, `/bots/${bot.id}/conversations`, {});
    const conv3 = (await convRes3.json()) as { id: string };

    let releaseJob1: () => void = () => {};
    let releaseJob2: () => void = () => {};
    const gate1 = new Promise<void>((r) => {
      releaseJob1 = r;
    });
    const gate2 = new Promise<void>((r) => {
      releaseJob2 = r;
    });

    let job1Started = false;
    let job2Started = false;
    let job3Started = false;

    let resolveStarted1: () => void = () => {};
    let resolveStarted2: () => void = () => {};
    const started1 = new Promise<void>((r) => {
      resolveStarted1 = r;
    });
    const started2 = new Promise<void>((r) => {
      resolveStarted2 = r;
    });

    fakeRuntime
      .scriptBot(bot.id, {
        waitFor: gate1,
        reply: "Bot reply 1",
        onExecute: () => {
          job1Started = true;
          resolveStarted1();
        },
      })
      .scriptBot(bot.id, {
        waitFor: gate2,
        reply: "Bot reply 2",
        onExecute: () => {
          job2Started = true;
          resolveStarted2();
        },
      })
      .scriptBot(bot.id, {
        reply: "Bot reply 3",
        onExecute: () => {
          job3Started = true;
        },
      });

    const worker1 = startTestWorker({ botId: bot.id });
    const worker2 = startTestWorker({ botId: bot.id });
    const worker3 = startTestWorker({ botId: bot.id });

    try {
      const msgRes1 = await request(alice.token, `/conversations/${conv1.id}/messages`, {
        clientMessageId: `bot-limit-1-${randomUUID()}`,
        content: "Message 1",
      });
      const msg1 = (await msgRes1.json()) as { jobId: string };

      const msgRes2 = await request(alice.token, `/conversations/${conv2.id}/messages`, {
        clientMessageId: `bot-limit-2-${randomUUID()}`,
        content: "Message 2",
      });
      const msg2 = (await msgRes2.json()) as { jobId: string };

      await Promise.all([started1, started2]);
      expect(job1Started).toBe(true);
      expect(job2Started).toBe(true);

      const msgRes3 = await request(alice.token, `/conversations/${conv3.id}/messages`, {
        clientMessageId: `bot-limit-3-${randomUUID()}`,
        content: "Message 3",
      });
      const msg3 = (await msgRes3.json()) as { jobId: string };

      await new Promise((r) => setTimeout(r, 100));
      expect(job3Started).toBe(false);

      releaseJob1();
      await waitForJob(alice.token, msg3.jobId);
      expect(job3Started).toBe(true);

      releaseJob2();
      await Promise.all([waitForJob(alice.token, msg1.jobId), waitForJob(alice.token, msg2.jobId)]);
    } finally {
      releaseJob1();
      releaseJob2();
      await Promise.all([worker1.stop(), worker2.stop(), worker3.stop()]);
    }
  });

  it("the per-User limit caps concurrent running Jobs for that User across all workers", async () => {
    const alice = await createUserWithToken();
    const botA = await createBotFor(alice, { name: "BotA", concurrencyLimit: 4 });
    const botB = await createBotFor(alice, { name: "BotB", concurrencyLimit: 4 });

    const convRes1 = await request(alice.token, `/bots/${botA.id}/conversations`, {});
    const conv1 = (await convRes1.json()) as { id: string };
    const convRes2 = await request(alice.token, `/bots/${botA.id}/conversations`, {});
    const conv2 = (await convRes2.json()) as { id: string };
    const convRes3 = await request(alice.token, `/bots/${botB.id}/conversations`, {});
    const conv3 = (await convRes3.json()) as { id: string };

    let releaseJob1: () => void = () => {};
    let releaseJob2: () => void = () => {};
    const gate1 = new Promise<void>((r) => {
      releaseJob1 = r;
    });
    const gate2 = new Promise<void>((r) => {
      releaseJob2 = r;
    });

    let job1Started = false;
    let job2Started = false;
    let job3Started = false;

    let resolveStarted1: () => void = () => {};
    let resolveStarted2: () => void = () => {};
    const started1 = new Promise<void>((r) => {
      resolveStarted1 = r;
    });
    const started2 = new Promise<void>((r) => {
      resolveStarted2 = r;
    });

    fakeRuntime
      .scriptBot(botA.id, {
        waitFor: gate1,
        reply: "BotA reply 1",
        onExecute: () => {
          job1Started = true;
          resolveStarted1();
        },
      })
      .scriptBot(botA.id, {
        waitFor: gate2,
        reply: "BotA reply 2",
        onExecute: () => {
          job2Started = true;
          resolveStarted2();
        },
      });

    fakeRuntime.scriptBot(botB.id, {
      reply: "BotB reply 3",
      onExecute: () => {
        job3Started = true;
      },
    });

    const workerA1 = startTestWorker({ botId: botA.id, userConcurrencyLimit: 2 });
    const workerA2 = startTestWorker({ botId: botA.id, userConcurrencyLimit: 2 });
    const workerB = startTestWorker({ botId: botB.id, userConcurrencyLimit: 2 });

    try {
      const msgRes1 = await request(alice.token, `/conversations/${conv1.id}/messages`, {
        clientMessageId: `user-limit-1-${randomUUID()}`,
        content: "Message 1",
      });
      const msg1 = (await msgRes1.json()) as { jobId: string };

      const msgRes2 = await request(alice.token, `/conversations/${conv2.id}/messages`, {
        clientMessageId: `user-limit-2-${randomUUID()}`,
        content: "Message 2",
      });
      const msg2 = (await msgRes2.json()) as { jobId: string };

      await Promise.all([started1, started2]);
      expect(job1Started).toBe(true);
      expect(job2Started).toBe(true);

      const msgRes3 = await request(alice.token, `/conversations/${conv3.id}/messages`, {
        clientMessageId: `user-limit-3-${randomUUID()}`,
        content: "Message 3",
      });
      const msg3 = (await msgRes3.json()) as { jobId: string };

      await new Promise((r) => setTimeout(r, 100));
      expect(job3Started).toBe(false);

      releaseJob1();
      await waitForJob(alice.token, msg3.jobId);
      expect(job3Started).toBe(true);

      releaseJob2();
      await Promise.all([waitForJob(alice.token, msg1.jobId), waitForJob(alice.token, msg2.jobId)]);
    } finally {
      releaseJob1();
      releaseJob2();
      await Promise.all([workerA1.stop(), workerA2.stop(), workerB.stop()]);
    }
  });

  it("no Job's result is committed twice when several workers are running", async () => {
    const alice = await createUserWithToken();
    const bot = await createBotFor(alice, { concurrencyLimit: 4 });

    const worker1 = startTestWorker({ botId: bot.id });
    const worker2 = startTestWorker({ botId: bot.id });
    const worker3 = startTestWorker({ botId: bot.id });

    try {
      const convRes1 = await request(alice.token, `/bots/${bot.id}/conversations`, {});
      const conv1 = (await convRes1.json()) as { id: string };
      const convRes2 = await request(alice.token, `/bots/${bot.id}/conversations`, {});
      const conv2 = (await convRes2.json()) as { id: string };

      const msgRes1 = await request(alice.token, `/conversations/${conv1.id}/messages`, {
        clientMessageId: `no-dup-1-${randomUUID()}`,
        content: "Test message 1",
      });
      const msg1 = (await msgRes1.json()) as { jobId: string };

      const msgRes2 = await request(alice.token, `/conversations/${conv2.id}/messages`, {
        clientMessageId: `no-dup-2-${randomUUID()}`,
        content: "Test message 2",
      });
      const msg2 = (await msgRes2.json()) as { jobId: string };

      await Promise.all([waitForJob(alice.token, msg1.jobId), waitForJob(alice.token, msg2.jobId)]);

      const list1Res = await request(alice.token, `/conversations/${conv1.id}/messages`);
      const list1 = (await list1Res.json()) as Array<{ content: string; botId?: string | null }>;
      const botReplies1 = list1.filter((m) => m.botId !== null);
      expect(botReplies1).toHaveLength(1);

      const list2Res = await request(alice.token, `/conversations/${conv2.id}/messages`);
      const list2 = (await list2Res.json()) as Array<{ content: string; botId?: string | null }>;
      const botReplies2 = list2.filter((m) => m.botId !== null);
      expect(botReplies2).toHaveLength(1);
    } finally {
      await Promise.all([worker1.stop(), worker2.stop(), worker3.stop()]);
    }
  });

  it("updating a Bot concurrency limit dynamically allows queued Jobs to run", async () => {
    const alice = await createUserWithToken();
    const bot = await createBotFor(alice, { concurrencyLimit: 1 });

    const convRes1 = await request(alice.token, `/bots/${bot.id}/conversations`, {});
    const conv1 = (await convRes1.json()) as { id: string };
    const convRes2 = await request(alice.token, `/bots/${bot.id}/conversations`, {});
    const conv2 = (await convRes2.json()) as { id: string };

    let releaseJob1: () => void = () => {};
    let releaseJob2: () => void = () => {};
    const gate1 = new Promise<void>((r) => {
      releaseJob1 = r;
    });
    const gate2 = new Promise<void>((r) => {
      releaseJob2 = r;
    });

    let job1Started = false;
    let job2Started = false;
    let resolveStarted1: () => void = () => {};
    let resolveStarted2: () => void = () => {};
    const started1 = new Promise<void>((r) => {
      resolveStarted1 = r;
    });
    const started2 = new Promise<void>((r) => {
      resolveStarted2 = r;
    });

    fakeRuntime
      .scriptBot(bot.id, {
        waitFor: gate1,
        reply: "Reply 1",
        onExecute: () => {
          job1Started = true;
          resolveStarted1();
        },
      })
      .scriptBot(bot.id, {
        waitFor: gate2,
        reply: "Reply 2",
        onExecute: () => {
          job2Started = true;
          resolveStarted2();
        },
      });

    const worker1 = startTestWorker({ botId: bot.id });
    const worker2 = startTestWorker({ botId: bot.id });

    try {
      const msgRes1 = await request(alice.token, `/conversations/${conv1.id}/messages`, {
        clientMessageId: `dyn-1-${randomUUID()}`,
        content: "Message 1",
      });
      const msg1 = (await msgRes1.json()) as { jobId: string };

      const msgRes2 = await request(alice.token, `/conversations/${conv2.id}/messages`, {
        clientMessageId: `dyn-2-${randomUUID()}`,
        content: "Message 2",
      });
      const msg2 = (await msgRes2.json()) as { jobId: string };

      await started1;
      expect(job1Started).toBe(true);

      await new Promise((r) => setTimeout(r, 100));
      expect(job2Started).toBe(false);

      const updateRes = await request(
        alice.token,
        `/bots/${bot.id}`,
        { concurrencyLimit: 2 },
        "PATCH",
      );
      expect(updateRes.status).toBe(200);

      await started2;
      expect(job2Started).toBe(true);

      releaseJob1();
      releaseJob2();

      await Promise.all([waitForJob(alice.token, msg1.jobId), waitForJob(alice.token, msg2.jobId)]);
    } finally {
      releaseJob1();
      releaseJob2();
      await Promise.all([worker1.stop(), worker2.stop()]);
    }
  });

  it("Jobs within one Conversation maintain message order even when an earlier Job retries with backoff", async () => {
    const alice = await createUserWithToken();
    const bot = await createBotFor(alice, { concurrencyLimit: 4 });

    const convRes = await request(alice.token, `/bots/${bot.id}/conversations`, {});
    const conv = (await convRes.json()) as { id: string };

    const executionLog: string[] = [];

    fakeRuntime
      .scriptBot(bot.id, {
        fail: "temporary rate limit",
        retryable: true,
        onExecute: () => {
          executionLog.push("job1_attempt1_fail");
        },
      })
      .scriptBot(bot.id, {
        reply: "Reply to message 1",
        onExecute: () => {
          executionLog.push("job1_attempt2_success");
        },
      })
      .scriptBot(bot.id, {
        reply: "Reply to message 2",
        onExecute: () => {
          executionLog.push("job2_attempt1_success");
        },
      });

    const worker1 = startTestWorker({ botId: bot.id, backoffBaseMs: 50 });
    const worker2 = startTestWorker({ botId: bot.id, backoffBaseMs: 50 });

    try {
      const msgRes1 = await request(alice.token, `/conversations/${conv.id}/messages`, {
        clientMessageId: `retry-order-1-${randomUUID()}`,
        content: "First message",
      });
      const msg1 = (await msgRes1.json()) as { jobId: string };

      const msgRes2 = await request(alice.token, `/conversations/${conv.id}/messages`, {
        clientMessageId: `retry-order-2-${randomUUID()}`,
        content: "Second message",
      });
      const msg2 = (await msgRes2.json()) as { jobId: string };

      await waitForJob(alice.token, msg2.jobId);
      const finishedJob1 = await waitForJob(alice.token, msg1.jobId);

      expect(finishedJob1.attempt).toBe(2);
      expect(executionLog).toEqual([
        "job1_attempt1_fail",
        "job1_attempt2_success",
        "job2_attempt1_success",
      ]);

      const listRes = await request(alice.token, `/conversations/${conv.id}/messages`);
      const list = (await listRes.json()) as Array<{ content: string }>;
      expect(list).toHaveLength(4);
      expect(list[0]?.content).toBe("First message");
      expect(list[1]?.content).toBe("Second message");
      expect(list[2]?.content).toBe("Reply to message 1");
      expect(list[3]?.content).toBe("Reply to message 2");
    } finally {
      await Promise.all([worker1.stop(), worker2.stop()]);
    }
  });
});
