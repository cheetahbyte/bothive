import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeRuntime } from "../src/runtime/fake.ts";
import { createRuntimeRegistry } from "../src/runtime/registry.ts";
import { createUserWithToken, request, startTestWorker, waitForJob } from "./helpers.ts";

type Account = { name: string; token: string };

type ListedJob = {
  id: string;
  conversationId: string;
  userId: string;
  status: string;
  attempt: number;
  runId: string | null;
  failureReason: string | null;
  nextEligibleAt: string;
  createdAt: string;
};

type ListedRun = {
  id: string;
  jobId: string;
  conversationId: string;
  userId: string;
  runtimeId: string;
  attempt: number;
  status: string;
  failureReason: string | null;
  createdAt: string;
  finishedAt: string | null;
};

async function createBot(owner: Account) {
  const res = await request(owner.token, "/bots", {
    name: "Observed",
    runtimeId: "fake",
    runtimeSettings: {},
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

async function grantMember(owner: Account, botId: string, member: Account) {
  const res = await request(owner.token, `/bots/${botId}/grants`, { userName: member.name });
  expect(res.status).toBe(201);
  return (await res.json()) as { userId: string };
}

async function openConversation(user: Account, botId: string) {
  const res = await request(user.token, `/bots/${botId}/conversations`, {});
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

async function postMessage(user: Account, conversationId: string, content: string) {
  const res = await request(user.token, `/conversations/${conversationId}/messages`, {
    clientMessageId: randomUUID(),
    content,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; jobId: string };
}

async function listJobs(token: string, botId: string) {
  const res = await request(token, `/bots/${botId}/jobs`);
  expect(res.status).toBe(200);
  return (await res.json()) as ListedJob[];
}

async function listRuns(token: string, botId: string) {
  const res = await request(token, `/bots/${botId}/runs`);
  expect(res.status).toBe(200);
  return (await res.json()) as ListedRun[];
}

describe("owner observability", () => {
  beforeEach(() => {
    fakeRuntime.reset();
  });

  afterEach(() => {
    fakeRuntime.reset();
  });

  it("an Owner lists Jobs and Runs of the Bot, including Jobs from a Member's Conversation", async () => {
    const owner = await createUserWithToken();
    const member = await createUserWithToken();
    const bot = await createBot(owner);
    await grantMember(owner, bot.id, member);
    const worker = startTestWorker({ botId: bot.id });

    try {
      const conv = await openConversation(member, bot.id);
      const posted = await postMessage(member, conv.id, "Member question");
      const job = await waitForJob(member.token, posted.jobId);
      expect(job.status).toBe("succeeded");

      const jobs = await listJobs(owner.token, bot.id);
      const listed = jobs.find((j) => j.id === posted.jobId);
      expect(listed).toMatchObject({
        status: "succeeded",
        attempt: 1,
        runId: job.runId,
        failureReason: null,
        conversationId: conv.id,
      });
      expect(typeof listed?.createdAt).toBe("string");
      expect(typeof listed?.nextEligibleAt).toBe("string");

      const runs = await listRuns(owner.token, bot.id);
      const run = runs.find((r) => r.id === job.runId);
      expect(run).toMatchObject({
        jobId: posted.jobId,
        status: "succeeded",
        attempt: 1,
        runtimeId: "fake",
        failureReason: null,
      });
      expect(typeof run?.createdAt).toBe("string");
      expect(typeof run?.finishedAt).toBe("string");
    } finally {
      await worker.stop();
    }
  });

  it("the listings never include message text or reply content", async () => {
    const owner = await createUserWithToken();
    const member = await createUserWithToken();
    const bot = await createBot(owner);
    await grantMember(owner, bot.id, member);
    const worker = startTestWorker({ botId: bot.id });

    try {
      const conv = await openConversation(member, bot.id);
      const secret = `classified-${randomUUID()}`;
      const posted = await postMessage(member, conv.id, secret);
      const job = await waitForJob(member.token, posted.jobId);
      expect(job.status).toBe("succeeded");

      const jobsBody = JSON.stringify(await listJobs(owner.token, bot.id));
      const runsBody = JSON.stringify(await listRuns(owner.token, bot.id));
      expect(jobsBody).toContain(posted.jobId);
      expect(runsBody).toContain(job.runId!);
      expect(jobsBody).not.toContain(secret);
      expect(runsBody).not.toContain(secret);
      expect(jobsBody).not.toContain("Echo:");
      expect(runsBody).not.toContain("Echo:");
    } finally {
      await worker.stop();
    }
  });

  it("a Member lists only the Jobs and Runs for their own messages", async () => {
    const owner = await createUserWithToken();
    const member = await createUserWithToken();
    const bot = await createBot(owner);
    await grantMember(owner, bot.id, member);
    const worker = startTestWorker({ botId: bot.id });

    try {
      const ownerConv = await openConversation(owner, bot.id);
      const ownerPost = await postMessage(owner, ownerConv.id, "Owner question");
      const memberConv = await openConversation(member, bot.id);
      const memberPost = await postMessage(member, memberConv.id, "Member question");
      const ownerJob = await waitForJob(owner.token, ownerPost.jobId);
      const memberJob = await waitForJob(member.token, memberPost.jobId);
      expect(ownerJob.status).toBe("succeeded");
      expect(memberJob.status).toBe("succeeded");

      const memberJobIds = (await listJobs(member.token, bot.id)).map((j) => j.id);
      expect(memberJobIds).toEqual([memberPost.jobId]);

      const memberRunIds = (await listRuns(member.token, bot.id)).map((r) => r.id);
      expect(memberRunIds).toEqual([memberJob.runId]);

      const ownerJobIds = (await listJobs(owner.token, bot.id)).map((j) => j.id);
      expect(ownerJobIds).toEqual(expect.arrayContaining([ownerPost.jobId, memberPost.jobId]));
    } finally {
      await worker.stop();
    }
  });

  it("a User without a grant, or whose grant was revoked, gets not found", async () => {
    const owner = await createUserWithToken();
    const member = await createUserWithToken();
    const stranger = await createUserWithToken();
    const bot = await createBot(owner);
    const grant = await grantMember(owner, bot.id, member);

    expect((await request(stranger.token, `/bots/${bot.id}/jobs`)).status).toBe(404);
    expect((await request(stranger.token, `/bots/${bot.id}/runs`)).status).toBe(404);

    expect((await request(member.token, `/bots/${bot.id}/jobs`)).status).toBe(200);
    const revoked = await request(
      owner.token,
      `/bots/${bot.id}/grants/${grant.userId}`,
      undefined,
      "DELETE",
    );
    expect(revoked.status).toBe(200);
    expect((await request(member.token, `/bots/${bot.id}/jobs`)).status).toBe(404);
    expect((await request(member.token, `/bots/${bot.id}/runs`)).status).toBe(404);

    expect((await request(owner.token, `/bots/not-a-uuid/jobs`)).status).toBe(404);
  });

  it("a Run that fails in the runtime shows its failure reason on the Job and the Run", async () => {
    const owner = await createUserWithToken();
    const bot = await createBot(owner);
    fakeRuntime.scriptBot(bot.id, { fail: "model exploded" });
    const worker = startTestWorker({ botId: bot.id });

    try {
      const conv = await openConversation(owner, bot.id);
      const posted = await postMessage(owner, conv.id, "Break please");
      const job = await waitForJob(owner.token, posted.jobId);
      expect(job).toMatchObject({ status: "failed", failureReason: "model exploded" });

      const run = (await listRuns(owner.token, bot.id)).find((r) => r.id === job.runId);
      expect(run).toMatchObject({ status: "failed", failureReason: "model exploded", attempt: 1 });
    } finally {
      await worker.stop();
    }
  });

  it("a Run on a Bot whose runtime is not registered in the worker fails with runtime_unavailable", async () => {
    const owner = await createUserWithToken();
    const bot = await createBot(owner);
    const worker = startTestWorker({ botId: bot.id }, createRuntimeRegistry([]));

    try {
      const conv = await openConversation(owner, bot.id);
      const posted = await postMessage(owner, conv.id, "Nobody home");
      const job = await waitForJob(owner.token, posted.jobId);
      expect(job).toMatchObject({ status: "failed", failureReason: "runtime_unavailable" });

      const run = (await listRuns(owner.token, bot.id)).find((r) => r.id === job.runId);
      expect(run).toMatchObject({ status: "failed", failureReason: "runtime_unavailable" });
    } finally {
      await worker.stop();
    }
  });

  it("a queued Job of a disabled Bot fails with bot_disabled and leaves no Run", async () => {
    const owner = await createUserWithToken();
    const bot = await createBot(owner);
    const conv = await openConversation(owner, bot.id);
    const posted = await postMessage(owner, conv.id, "Waiting in line");

    const disabled = await request(owner.token, `/bots/${bot.id}/disable`, {});
    expect(disabled.status).toBe(200);

    const worker = startTestWorker({ botId: bot.id });
    try {
      const job = await waitForJob(owner.token, posted.jobId);
      expect(job).toMatchObject({ status: "failed", failureReason: "bot_disabled", runId: null });

      const runs = await listRuns(owner.token, bot.id);
      expect(runs.filter((r) => r.jobId === posted.jobId)).toHaveLength(0);
    } finally {
      await worker.stop();
    }
  });

  it("a Run released on graceful shutdown is recorded failed with lease_expired", async () => {
    const owner = await createUserWithToken();
    const bot = await createBot(owner);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    fakeRuntime.scriptBot(bot.id, { hang: true, onExecute: () => markStarted() });
    const worker = startTestWorker({ botId: bot.id, backoffBaseMs: 1 });

    const conv = await openConversation(owner, bot.id);
    const posted = await postMessage(owner, conv.id, "Interrupted work");
    await started;
    await worker.stop();

    const job = (await listJobs(owner.token, bot.id)).find((j) => j.id === posted.jobId);
    expect(job?.status).toBe("queued");
    expect(job?.attempt).toBe(0);

    const runs = (await listRuns(owner.token, bot.id)).filter((r) => r.jobId === posted.jobId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "failed", failureReason: "lease_expired", attempt: 1 });
  });

  it("a Run whose lease expires is recorded failed with lease_expired and the retry gets its own Run", async () => {
    const owner = await createUserWithToken();
    const bot = await createBot(owner);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    fakeRuntime.scriptBot(bot.id, { hang: true, onExecute: () => markStarted() });
    const stalled = startTestWorker({
      botId: bot.id,
      leaseDurationMs: 200,
      renewIntervalMs: 60_000,
    });

    const conv = await openConversation(owner, bot.id);
    const posted = await postMessage(owner, conv.id, "Stalled work");
    await started;

    const recovery = startTestWorker({ botId: bot.id, leaseDurationMs: 200, backoffBaseMs: 1 });
    try {
      const job = await waitForJob(owner.token, posted.jobId);
      expect(job).toMatchObject({ status: "succeeded", attempt: 2 });

      const runs = (await listRuns(owner.token, bot.id))
        .filter((r) => r.jobId === posted.jobId)
        .sort((a, b) => a.attempt - b.attempt);
      expect(runs.map((r) => [r.attempt, r.status, r.failureReason])).toEqual([
        [1, "failed", "lease_expired"],
        [2, "succeeded", null],
      ]);
      expect(runs[1]?.id).toBe(job.runId);
    } finally {
      await recovery.stop();
      await stalled.stop();
    }
  });
});
