import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { describe, expect, it } from "vitest";
import { bots, conversations, jobs, messages, runs } from "../src/db/schema.ts";
import type { botSchema } from "../src/identity/bots.ts";
import { fakeRuntime } from "../src/runtime/fake.ts";
import { createRuntimeRegistry } from "../src/runtime/registry.ts";
import { createUserWithToken, db, request, startTestWorker, waitForJob } from "./helpers.ts";

type Bot = z.infer<typeof botSchema>;

const validBot = {
  name: "Helper",
  runtimeId: "fake",
  runtimeSettings: { model: "x", temperature: 0.2 },
};

describe("bots", () => {
  it("a User creates a Bot with name, runtime ID and runtime settings", async () => {
    const alice = await createUserWithToken();
    const response = await request(alice.token, "/bots", validBot);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject(validBot);
  });

  it("the creator lists and gets their own Bots", async () => {
    const alice = await createUserWithToken();
    const created = (await (await request(alice.token, "/bots", validBot)).json()) as Bot;

    const list = await (await request(alice.token, "/bots")).json();
    expect(list).toEqual([created]);

    const got = await request(alice.token, `/bots/${created.id}`);
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual(created);
  });

  it("Bots are private: another User cannot list or get them", async () => {
    const alice = await createUserWithToken();
    const bob = await createUserWithToken();
    const created = (await (await request(alice.token, "/bots", validBot)).json()) as Bot;

    expect(await (await request(bob.token, "/bots")).json()).toEqual([]);
    const got = await request(bob.token, `/bots/${created.id}`);
    expect(got.status).toBe(404);
    const unknown = await request(bob.token, `/bots/${randomUUID()}`);
    expect(unknown.status).toBe(404);
    expect(await got.json()).toEqual(await unknown.json());
  });

  it("a malformed Bot ID answers as not found", async () => {
    const alice = await createUserWithToken();
    expect((await request(alice.token, "/bots/nope")).status).toBe(404);
  });

  it("runtime settings default to an empty object", async () => {
    const alice = await createUserWithToken();
    const response = await request(alice.token, "/bots", { name: "Bare", runtimeId: "fake" });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ runtimeSettings: {} });
  });

  it.each([
    ["missing name", { runtimeId: "fake" }],
    ["blank name", { name: "  ", runtimeId: "fake" }],
    ["missing runtime ID", { name: "Helper" }],
    ["non-object runtime settings", { name: "Helper", runtimeId: "fake", runtimeSettings: [1] }],
  ])("rejects an invalid Bot: %s", async (_label, body) => {
    const alice = await createUserWithToken();
    const response = await request(alice.token, "/bots", body);
    expect(response.status).toBe(400);
  });

  it("rejects creating a Bot with an unregistered runtime", async () => {
    const alice = await createUserWithToken();
    const response = await request(alice.token, "/bots", {
      name: "Helper",
      runtimeId: "unregistered",
    });
    expect(response.status).toBe(400);
  });

  it("rejects unauthenticated Bot creation", async () => {
    expect((await request(null, "/bots", validBot)).status).toBe(401);
  });

  it("an Owner can update a Bot's configuration and per-Bot concurrency limit", async () => {
    const alice = await createUserWithToken();
    const createRes = await request(alice.token, "/bots", validBot);
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as Bot;
    expect(created.concurrencyLimit).toBe(4);

    const updateRes = await request(
      alice.token,
      `/bots/${created.id}`,
      {
        name: "RenamedHelper",
        runtimeSettings: { model: "y", temperature: 0.9 },
        concurrencyLimit: 8,
      },
      "PATCH",
    );
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as Bot;
    expect(updated.name).toBe("RenamedHelper");
    expect(updated.runtimeSettings).toEqual({ model: "y", temperature: 0.9 });
    expect(updated.concurrencyLimit).toBe(8);
    expect(updated.runtimeId).toBe("fake");

    const got = await request(alice.token, `/bots/${created.id}`);
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual(updated);

    const customBotRes = await request(alice.token, "/bots", {
      ...validBot,
      name: "CustomConcurrency",
      concurrencyLimit: 2,
    });
    expect(customBotRes.status).toBe(201);
    const customBot = (await customBotRes.json()) as Bot;
    expect(customBot.concurrencyLimit).toBe(2);
  });

  it("rejects creating or updating a Bot with an unregistered runtime ID or invalid fields", async () => {
    const alice = await createUserWithToken();
    const bot = (await (await request(alice.token, "/bots", validBot)).json()) as Bot;

    const unregUpdate = await request(
      alice.token,
      `/bots/${bot.id}`,
      { runtimeId: "unregistered" },
      "PATCH",
    );
    expect(unregUpdate.status).toBe(400);

    for (const badLimit of [0, -1, 1.5, "five"]) {
      const badLimitRes = await request(
        alice.token,
        `/bots/${bot.id}`,
        { concurrencyLimit: badLimit },
        "PATCH",
      );
      expect(badLimitRes.status).toBe(400);
    }

    const blankNameRes = await request(alice.token, `/bots/${bot.id}`, { name: "   " }, "PATCH");
    expect(blankNameRes.status).toBe(400);

    const unknownFieldRes = await request(
      alice.token,
      `/bots/${bot.id}`,
      { unexpected: true },
      "PATCH",
    );
    expect(unknownFieldRes.status).toBe(400);
  });

  it("Members cannot update, disable, enable or delete the Bot", async () => {
    const alice = await createUserWithToken();
    const bob = await createUserWithToken();
    const charlie = await createUserWithToken();
    const bot = (await (await request(alice.token, "/bots", validBot)).json()) as Bot;

    const grantRes = await request(alice.token, `/bots/${bot.id}/grants`, {
      userName: bob.name,
      role: "member",
    });
    expect(grantRes.status).toBe(201);

    expect((await request(bob.token, `/bots/${bot.id}`, { name: "Hacked" }, "PATCH")).status).toBe(
      404,
    );
    expect((await request(bob.token, `/bots/${bot.id}/disable`, {})).status).toBe(404);
    expect((await request(bob.token, `/bots/${bot.id}/enable`, {})).status).toBe(404);
    expect((await request(bob.token, `/bots/${bot.id}`, undefined, "DELETE")).status).toBe(404);

    expect(
      (await request(charlie.token, `/bots/${bot.id}`, { name: "Hacked" }, "PATCH")).status,
    ).toBe(404);
    expect((await request(charlie.token, `/bots/${bot.id}/disable`, {})).status).toBe(404);
    expect((await request(charlie.token, `/bots/${bot.id}/enable`, {})).status).toBe(404);
    expect((await request(charlie.token, `/bots/${bot.id}`, undefined, "DELETE")).status).toBe(404);
  });

  it("a disabled Bot rejects new posts and can be re-enabled", async () => {
    const alice = await createUserWithToken();
    const bot = (await (await request(alice.token, "/bots", validBot)).json()) as Bot;

    const convRes = await request(alice.token, `/bots/${bot.id}/conversations`, {});
    expect(convRes.status).toBe(201);
    const conv = (await convRes.json()) as { id: string };

    const disableRes = await request(alice.token, `/bots/${bot.id}/disable`, {});
    expect(disableRes.status).toBe(200);
    const disabledBot = (await disableRes.json()) as Bot;
    expect(disabledBot.disabledAt).not.toBeNull();

    const listRes = await request(alice.token, "/bots");
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as Bot[];
    expect(list.map((b) => b.id)).toContain(bot.id);

    const gotRes = await request(alice.token, `/bots/${bot.id}`);
    expect(gotRes.status).toBe(200);
    expect(((await gotRes.json()) as Bot).disabledAt).not.toBeNull();

    const rejectPostRes = await request(alice.token, `/conversations/${conv.id}/messages`, {
      clientMessageId: "msg-disabled-1",
      content: "Hello while disabled",
    });
    expect(rejectPostRes.status).toBe(400);
    expect(await rejectPostRes.json()).toEqual({ error: "bot_disabled" });

    const enableRes = await request(alice.token, `/bots/${bot.id}/enable`, {});
    expect(enableRes.status).toBe(200);
    const enabledBot = (await enableRes.json()) as Bot;
    expect(enabledBot.disabledAt).toBeNull();

    const acceptPostRes = await request(alice.token, `/conversations/${conv.id}/messages`, {
      clientMessageId: "msg-enabled-1",
      content: "Hello after re-enabled",
    });
    expect(acceptPostRes.status).toBe(201);
  });

  it("queued Jobs of a disabled Bot fail with bot_disabled when claimed, while Runs in progress complete", async () => {
    const alice = await createUserWithToken();
    const bot1 = (await (await request(alice.token, "/bots", validBot)).json()) as Bot;
    const conv1 = (await (
      await request(alice.token, `/bots/${bot1.id}/conversations`, {})
    ).json()) as { id: string };

    const post1Res = await request(alice.token, `/conversations/${conv1.id}/messages`, {
      clientMessageId: "queued-before-disable",
      content: "Process me?",
    });
    expect(post1Res.status).toBe(201);
    const post1 = (await post1Res.json()) as { jobId: string };

    const disableRes = await request(alice.token, `/bots/${bot1.id}/disable`, {});
    expect(disableRes.status).toBe(200);

    const worker1 = startTestWorker({ botId: bot1.id });
    try {
      const job1 = await waitForJob(alice.token, post1.jobId);
      expect(job1.status).toBe("failed");
      expect(job1.failureReason).toBe("bot_disabled");
      expect(job1.runId).toBeNull();
      expect(job1.attempt).toBe(0);
    } finally {
      await worker1.stop();
    }

    const bot2 = (await (
      await request(alice.token, "/bots", { ...validBot, name: "BotInProgress" })
    ).json()) as Bot;
    const conv2 = (await (
      await request(alice.token, `/bots/${bot2.id}/conversations`, {})
    ).json()) as { id: string };

    let runStartedResolve: () => void;
    const runStartedPromise = new Promise<void>((resolve) => {
      runStartedResolve = resolve;
    });
    let allowFinishResolve: () => void;
    const allowFinishPromise = new Promise<void>((resolve) => {
      allowFinishResolve = resolve;
    });

    fakeRuntime.setDefaultHandler(async function* (request, _signal) {
      if (request.bot.id === bot2.id) {
        runStartedResolve();
        await allowFinishPromise;
        yield { type: "output_text", text: "Finished during disable" };
        yield {
          type: "usage",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        };
        yield { type: "completed" };
      }
    });

    const post2Res = await request(alice.token, `/conversations/${conv2.id}/messages`, {
      clientMessageId: "in-progress-msg",
      content: "Start before disable",
    });
    expect(post2Res.status).toBe(201);
    const post2 = (await post2Res.json()) as { jobId: string };

    const worker2 = startTestWorker({ botId: bot2.id });
    try {
      await runStartedPromise;
      const disableBot2Res = await request(alice.token, `/bots/${bot2.id}/disable`, {});
      expect(disableBot2Res.status).toBe(200);
      allowFinishResolve!();

      const job2 = await waitForJob(alice.token, post2.jobId);
      expect(job2.status).toBe("succeeded");

      const msgsRes = await request(alice.token, `/conversations/${conv2.id}/messages`);
      expect(msgsRes.status).toBe(200);
      const msgs = (await msgsRes.json()) as Array<{ content: string; botId: string | null }>;
      expect(msgs).toHaveLength(2);
      expect(msgs[1]?.content).toBe("Finished during disable");
      expect(msgs[1]?.botId).toBe(bot2.id);
    } finally {
      fakeRuntime.reset();
      await worker2.stop();
    }
  });

  it("a soft-deleted Bot disappears from all listings and rejects all use, while history remains in DB", async () => {
    const alice = await createUserWithToken();
    const bot = (await (await request(alice.token, "/bots", validBot)).json()) as Bot;
    const conv = (await (
      await request(alice.token, `/bots/${bot.id}/conversations`, {})
    ).json()) as { id: string };

    const postRes = await request(alice.token, `/conversations/${conv.id}/messages`, {
      clientMessageId: "pre-delete-msg",
      content: "Record history",
    });
    expect(postRes.status).toBe(201);
    const post = (await postRes.json()) as { id: string; jobId: string };

    const worker = startTestWorker({ botId: bot.id });
    let runId: string;
    try {
      const job = await waitForJob(alice.token, post.jobId);
      expect(job.status).toBe("succeeded");
      runId = job.runId!;
    } finally {
      await worker.stop();
    }

    const deleteRes = await request(alice.token, `/bots/${bot.id}`, undefined, "DELETE");
    expect(deleteRes.status).toBe(200);
    expect(await deleteRes.json()).toEqual({ success: true });

    const listRes = await request(alice.token, "/bots");
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as Bot[];
    expect(list.map((b) => b.id)).not.toContain(bot.id);

    expect((await request(alice.token, `/bots/${bot.id}`)).status).toBe(404);
    expect(
      (await request(alice.token, `/bots/${bot.id}`, { name: "TryUpdate" }, "PATCH")).status,
    ).toBe(404);
    expect((await request(alice.token, `/bots/${bot.id}/disable`, {})).status).toBe(404);
    expect((await request(alice.token, `/bots/${bot.id}/enable`, {})).status).toBe(404);
    expect((await request(alice.token, `/bots/${bot.id}`, undefined, "DELETE")).status).toBe(404);
    expect((await request(alice.token, `/bots/${bot.id}/grants`)).status).toBe(404);
    expect((await request(alice.token, `/bots/${bot.id}/grants`, { userName: "any" })).status).toBe(
      404,
    );
    expect((await request(alice.token, `/bots/${bot.id}/conversations`)).status).toBe(404);
    expect((await request(alice.token, `/bots/${bot.id}/conversations`, {})).status).toBe(404);
    expect((await request(alice.token, `/conversations/${conv.id}`)).status).toBe(404);
    expect(
      (
        await request(alice.token, `/conversations/${conv.id}/messages`, {
          clientMessageId: "post-delete-msg",
          content: "Should fail",
        })
      ).status,
    ).toBe(404);
    expect((await request(alice.token, `/conversations/${conv.id}/messages`)).status).toBe(404);
    expect((await request(alice.token, `/jobs/${post.jobId}`)).status).toBe(404);
    expect((await request(alice.token, `/runs/${runId}`)).status).toBe(404);

    const [botRow] = await db.select().from(bots).where(eq(bots.id, bot.id));
    expect(botRow).toBeDefined();
    expect(botRow!.deletedAt).not.toBeNull();

    const convRows = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(convRows).toHaveLength(1);

    const msgRows = await db.select().from(messages).where(eq(messages.conversationId, conv.id));
    expect(msgRows).toHaveLength(2);

    const jobRows = await db.select().from(jobs).where(eq(jobs.id, post.jobId));
    expect(jobRows).toHaveLength(1);

    const runRows = await db.select().from(runs).where(eq(runs.id, runId));
    expect(runRows).toHaveLength(1);
  });

  it("a Job whose Bot points at an unregistered runtime fails with runtime_unavailable", async () => {
    const alice = await createUserWithToken();
    const bot = (await (await request(alice.token, "/bots", validBot)).json()) as Bot;
    const conv = (await (
      await request(alice.token, `/bots/${bot.id}/conversations`, {})
    ).json()) as { id: string };

    const postRes = await request(alice.token, `/conversations/${conv.id}/messages`, {
      clientMessageId: "unreg-runtime-msg",
      content: "Fail my runtime",
    });
    expect(postRes.status).toBe(201);
    const post = (await postRes.json()) as { jobId: string };

    const emptyRegistry = createRuntimeRegistry([]);
    const worker = startTestWorker({ botId: bot.id }, emptyRegistry);
    try {
      const job = await waitForJob(alice.token, post.jobId);
      expect(job.status).toBe("failed");
      expect(job.failureReason).toBe("runtime_unavailable");
      expect(typeof job.runId).toBe("string");

      const runRes = await request(alice.token, `/runs/${job.runId!}`);
      expect(runRes.status).toBe(200);
      const run = (await runRes.json()) as { status: string; failureReason: string };
      expect(run.status).toBe("failed");
      expect(run.failureReason).toBe("runtime_unavailable");
    } finally {
      await worker.stop();
    }
  });
});
