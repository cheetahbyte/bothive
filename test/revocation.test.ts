import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeRuntime } from "../src/runtime/fake.ts";
import { createWorker } from "../src/worker/worker.ts";
import {
  createUserWithToken,
  db,
  request,
  startTestWorker,
  testRegistry,
  waitForJob,
} from "./helpers.ts";

const validBot = {
  name: "Helper",
  runtimeId: "fake",
  runtimeSettings: { model: "test-model" },
};

async function createBotFor(owner: { token: string }) {
  const res = await request(owner.token, "/bots", validBot);
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

async function shareWithMember(owner: { token: string }, botId: string, member: { name: string }) {
  const res = await request(owner.token, `/bots/${botId}/grants`, { userName: member.name });
  expect(res.status).toBe(201);
  return (await res.json()) as { userId: string };
}

async function revokeMember(owner: { token: string }, botId: string, memberUserId: string) {
  const res = await request(
    owner.token,
    `/bots/${botId}/grants/${memberUserId}`,
    undefined,
    "DELETE",
  );
  expect(res.status).toBe(200);
}

async function startConversation(token: string, botId: string) {
  const res = await request(token, `/bots/${botId}/conversations`, {});
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

async function postMessage(
  token: string,
  conversationId: string,
  clientMessageId: string,
  content: string,
) {
  const res = await request(token, `/conversations/${conversationId}/messages`, {
    clientMessageId,
    content,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; jobId: string };
}

async function readJob(token: string, jobId: string) {
  const res = await request(token, `/jobs/${jobId}`);
  expect(res.status).toBe(200);
  return (await res.json()) as { status: string; failureReason: string | null };
}

async function listContents(token: string, conversationId: string) {
  const res = await request(token, `/conversations/${conversationId}/messages`);
  expect(res.status).toBe(200);
  return ((await res.json()) as Array<{ content: string }>).map((m) => m.content);
}

describe("revocation at claim and at commit", () => {
  beforeEach(() => {
    fakeRuntime.reset();
  });

  afterEach(() => {
    fakeRuntime.reset();
  });

  it("a Job queued by a Member before revocation fails with revoked when claimed and never executes", async () => {
    const owner = await createUserWithToken();
    const member = await createUserWithToken();
    const bot = await createBotFor(owner);
    const grant = await shareWithMember(owner, bot.id, member);
    const conv = await startConversation(member.token, bot.id);
    const queued = await postMessage(member.token, conv.id, "before-revoke", "Hello");

    let executions = 0;
    fakeRuntime.scriptBot(bot.id, {
      reply: "Should never be stored",
      onExecute: () => {
        executions += 1;
      },
    });
    await revokeMember(owner, bot.id, grant.userId);

    const worker = createWorker(db, testRegistry, { botId: bot.id, shutdownTimeoutMs: 0 });
    await worker.runOnce();

    expect(executions).toBe(0);
    await shareWithMember(owner, bot.id, member);
    const job = await readJob(member.token, queued.jobId);
    expect(job.status).toBe("failed");
    expect(job.failureReason).toBe("revoked");
  });

  it("revoking access while a Run is in progress discards the reply and fails the Job with revoked", async () => {
    const owner = await createUserWithToken();
    const member = await createUserWithToken();
    const bot = await createBotFor(owner);
    const grant = await shareWithMember(owner, bot.id, member);
    const conv = await startConversation(member.token, bot.id);
    const queued = await postMessage(member.token, conv.id, "in-flight", "Tell me");

    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fakeRuntime.scriptBot(bot.id, {
      reply: "Confidential reply",
      waitFor: gate,
      onExecute: markStarted,
    });

    const worker = createWorker(db, testRegistry, { botId: bot.id, shutdownTimeoutMs: 0 });
    const run = worker.runOnce();
    await started;

    await revokeMember(owner, bot.id, grant.userId);
    expect((await request(member.token, `/conversations/${conv.id}/messages`)).status).toBe(404);

    release();
    await expect(run).resolves.toBe(true);

    await shareWithMember(owner, bot.id, member);
    expect(await listContents(member.token, conv.id)).toEqual(["Tell me"]);
    const job = await readJob(member.token, queued.jobId);
    expect(job.status).toBe("failed");
    expect(job.failureReason).toBe("revoked");
  });

  it("revoking a Member leaves the Owner's Jobs on the same Bot unaffected", async () => {
    const owner = await createUserWithToken();
    const member = await createUserWithToken();
    const bot = await createBotFor(owner);
    const grant = await shareWithMember(owner, bot.id, member);
    const memberConv = await startConversation(member.token, bot.id);
    const ownerConv = await startConversation(owner.token, bot.id);
    const memberJob = await postMessage(
      member.token,
      memberConv.id,
      "member-queued",
      "From member",
    );
    const ownerJob = await postMessage(owner.token, ownerConv.id, "owner-1", "From owner");
    await revokeMember(owner, bot.id, grant.userId);

    const worker = startTestWorker({ botId: bot.id, shutdownTimeoutMs: 5000 });
    try {
      const done = await waitForJob(owner.token, ownerJob.jobId);
      expect(done.status).toBe("succeeded");
    } finally {
      await worker.stop();
    }

    expect(await listContents(owner.token, ownerConv.id)).toEqual([
      "From owner",
      "Echo: From owner",
    ]);
    await shareWithMember(owner, bot.id, member);
    const failed = await readJob(member.token, memberJob.jobId);
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toBe("revoked");
  });
});
