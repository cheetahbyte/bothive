import http from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { fakeRuntime } from "../src/runtime/fake.ts";
import { databaseUrl } from "./cli.ts";
import {
  app,
  createUserWithToken,
  request,
  spawnApiProcess,
  spawnWorkerProcess,
  startTestWorker,
  waitForApi,
  waitForJob,
} from "./helpers.ts";

const validBot = {
  name: "RestartHelper",
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

async function waitForJobState(
  token: string,
  jobId: string,
  targetStatus: string,
  timeoutMs = 5000,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await request(token, `/jobs/${jobId}`);
    if (res.status === 200) {
      const job = (await res.json()) as { status: string; attempt: number };
      if (job.status === targetStatus) return job;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for job ${jobId} to reach status ${targetStatus}`);
}

describe("restart durability and graceful shutdown", () => {
  describe("health endpoint", () => {
    it("serves an unauthenticated health endpoint before the auth check that reveals only liveness", async () => {
      const res = await app.request("/health", { method: "GET" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({ status: "ok" });

      const unauthBots = await request(null, "/bots");
      expect(unauthBots.status).toBe(401);
    });
  });

  describe("API restart durability", () => {
    it("messages accepted before an API restart get replies afterwards", async () => {
      const alice = await createUserWithToken();
      const bot = await createBotFor(alice);
      const convRes = await request(alice.token, `/bots/${bot.id}/conversations`, {});
      const conv = (await convRes.json()) as { id: string };

      const api1 = spawnApiProcess();
      await waitForApi(api1.url);

      const msgRes = await fetch(`${api1.url}/conversations/${conv.id}/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${alice.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          clientMessageId: `api-restart-${randomUUID()}`,
          content: "Message before API restart",
        }),
      });
      expect(msgRes.status).toBe(201);
      const msgData = (await msgRes.json()) as { id: string; jobId: string };

      await api1.stop();

      const worker = startTestWorker({ botId: bot.id });
      try {
        await waitForJob(alice.token, msgData.jobId);

        const api2 = spawnApiProcess();
        try {
          await waitForApi(api2.url);

          const msgsRes = await fetch(`${api2.url}/conversations/${conv.id}/messages`, {
            headers: { authorization: `Bearer ${alice.token}` },
          });
          expect(msgsRes.status).toBe(200);
          const msgs = (await msgsRes.json()) as Array<{ content: string; botId: string | null }>;
          expect(msgs).toHaveLength(2);
          expect(msgs[1]?.botId).toBe(bot.id);
          expect(msgs[1]?.content).toBe("Echo: Message before API restart");
        } finally {
          await api2.stop();
        }
      } finally {
        await worker.stop();
      }
    });
  });

  describe("worker restart durability", () => {
    it("messages accepted before all workers are restarted get replies afterwards", async () => {
      const alice = await createUserWithToken();
      const bot = await createBotFor(alice, { runtimeSettings: { delayMs: 400 } });
      const convRes = await request(alice.token, `/bots/${bot.id}/conversations`, {});
      const conv = (await convRes.json()) as { id: string };

      const msgRes = await request(alice.token, `/conversations/${conv.id}/messages`, {
        clientMessageId: `worker-restart-${randomUUID()}`,
        content: "Message before worker restart",
      });
      expect(msgRes.status).toBe(201);
      const msgData = (await msgRes.json()) as { id: string; jobId: string };

      const workerProc1 = spawnWorkerProcess({
        WORKER_BOT_ID: bot.id,
        JOB_LEASE_DURATION_MS: "5000",
      });

      try {
        await waitForJobState(alice.token, msgData.jobId, "running");

        await workerProc1.stop();
        const exit1 = await workerProc1.waitForExit();
        expect(exit1.code).toBe(0);

        const replacementWorker = startTestWorker({ botId: bot.id });
        try {
          const job = await waitForJob(alice.token, msgData.jobId);
          expect(job.status).toBe("succeeded");

          const msgsRes = await request(alice.token, `/conversations/${conv.id}/messages`);
          const msgs = (await msgsRes.json()) as Array<{ content: string; botId: string | null }>;
          expect(msgs).toHaveLength(2);
          expect(msgs[1]?.botId).toBe(bot.id);
          expect(msgs[1]?.content).toBe("Echo: Message before worker restart");
        } finally {
          await replacementWorker.stop();
        }
      } finally {
        try {
          workerProc1.process.kill("SIGKILL");
        } catch {}
      }
    });
  });

  describe("PostgreSQL restart durability", () => {
    it("messages accepted before a PostgreSQL restart get replies afterwards, with workers reconnecting on their own", async () => {
      const alice = await createUserWithToken();
      const bot = await createBotFor(alice);
      const conv = (await (
        await request(alice.token, `/bots/${bot.id}/conversations`, {})
      ).json()) as { id: string };

      const appName = `restart-${randomUUID()}`;
      const workerUrl = new URL(databaseUrl);
      workerUrl.searchParams.set("application_name", appName);
      const workerProc = spawnWorkerProcess({
        DATABASE_URL: workerUrl.toString(),
        WORKER_BOT_ID: bot.id,
      });
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();

      try {
        const connected = async () =>
          (
            await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1", [
              appName,
            ])
          ).rowCount;
        while (!(await connected())) await new Promise((r) => setTimeout(r, 20));

        // pogg logins switch to an owner role; signalling the login's own sessions needs the login role.
        // Only the worker's sessions are dropped, so parallel test files keep theirs.
        await admin.query("SET ROLE NONE");
        // Repeated drops hit the worker both while idle and mid-query.
        let terminated = 0;
        for (let i = 0; i < 20; i++) {
          const result = await admin.query(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1",
            [appName],
          );
          terminated += result.rowCount ?? 0;
          await new Promise((r) => setTimeout(r, 25));
        }
        expect(terminated).toBeGreaterThan(0);
        expect(workerProc.process.exitCode).toBeNull();

        const msg = (await (
          await request(alice.token, `/conversations/${conv.id}/messages`, {
            clientMessageId: `pg-restart-${randomUUID()}`,
            content: "Message before PostgreSQL restart",
          })
        ).json()) as { jobId: string };

        const job = await waitForJob(alice.token, msg.jobId, 10000);
        expect(job.status).toBe("succeeded");

        const msgs = (await (
          await request(alice.token, `/conversations/${conv.id}/messages`)
        ).json()) as Array<{ content: string; botId: string | null }>;
        expect(msgs).toHaveLength(2);
        expect(msgs[1]?.botId).toBe(bot.id);
        expect(msgs[1]?.content).toBe("Echo: Message before PostgreSQL restart");
      } finally {
        await admin.end();
        await workerProc.stop();
      }
    });
  });

  describe("worker stop signal handling", () => {
    it("on a stop signal a worker stops claiming and finishes its Job before exiting", async () => {
      const alice = await createUserWithToken();
      const bot = await createBotFor(alice, { runtimeSettings: { delayMs: 300 } });
      const convRes = await request(alice.token, `/bots/${bot.id}/conversations`, {});
      const conv = (await convRes.json()) as { id: string };

      const msgRes1 = await request(alice.token, `/conversations/${conv.id}/messages`, {
        clientMessageId: `stop-finish-1-${randomUUID()}`,
        content: "First message to finish",
      });
      const msg1 = (await msgRes1.json()) as { jobId: string };

      const msgRes2 = await request(alice.token, `/conversations/${conv.id}/messages`, {
        clientMessageId: `stop-finish-2-${randomUUID()}`,
        content: "Second message that must remain queued",
      });
      const msg2 = (await msgRes2.json()) as { jobId: string };

      const workerProc = spawnWorkerProcess({
        WORKER_BOT_ID: bot.id,
        SHUTDOWN_TIMEOUT_MS: "3000",
      });

      try {
        await waitForJobState(alice.token, msg1.jobId, "running");

        workerProc.process.kill("SIGTERM");
        const exit = await workerProc.waitForExit();
        expect(exit.code).toBe(0);

        const job1Res = await request(alice.token, `/jobs/${msg1.jobId}`);
        const job1 = (await job1Res.json()) as { status: string };
        expect(job1.status).toBe("succeeded");

        const job2Res = await request(alice.token, `/jobs/${msg2.jobId}`);
        const job2 = (await job2Res.json()) as { status: string; attempt: number };
        expect(job2.status).toBe("queued");
        expect(job2.attempt).toBe(0);
      } finally {
        try {
          workerProc.process.kill("SIGKILL");
        } catch {}
      }
    });

    it("on a stop signal a worker releases its Job if the shutdown deadline expires before completion", async () => {
      const alice = await createUserWithToken();
      const bot = await createBotFor(alice, { runtimeSettings: { delayMs: 2500 } });
      const convRes = await request(alice.token, `/bots/${bot.id}/conversations`, {});
      const conv = (await convRes.json()) as { id: string };

      const msgRes = await request(alice.token, `/conversations/${conv.id}/messages`, {
        clientMessageId: `stop-release-${randomUUID()}`,
        content: "Message whose job will be released",
      });
      const msg = (await msgRes.json()) as { jobId: string };

      const workerProc = spawnWorkerProcess({
        WORKER_BOT_ID: bot.id,
        SHUTDOWN_TIMEOUT_MS: "80",
      });

      try {
        await waitForJobState(alice.token, msg.jobId, "running");

        workerProc.process.kill("SIGTERM");
        const exit = await workerProc.waitForExit();
        expect(exit.code).toBe(0);

        const jobRes = await request(alice.token, `/jobs/${msg.jobId}`);
        const job = (await jobRes.json()) as { status: string };
        expect(job.status).toBe("queued");

        fakeRuntime.scriptBot(bot.id, { reply: "Recovered after release" });
        const replacementWorker = startTestWorker({ botId: bot.id });
        try {
          const finishedJob = await waitForJob(alice.token, msg.jobId);
          expect(finishedJob.status).toBe("succeeded");

          const msgsRes = await request(alice.token, `/conversations/${conv.id}/messages`);
          const msgs = (await msgsRes.json()) as Array<{ content: string; botId: string | null }>;
          expect(msgs).toHaveLength(2);
          expect(msgs[1]?.content).toBe("Recovered after release");
        } finally {
          await replacementWorker.stop();
        }
      } finally {
        try {
          workerProc.process.kill("SIGKILL");
        } catch {}
      }
    });
  });

  describe("repeated stop signals", () => {
    it("repeated stop signals during worker shutdown with a Job in progress do not crash or close db pool twice", async () => {
      const alice = await createUserWithToken();
      const bot = await createBotFor(alice, { runtimeSettings: { delayMs: 600 } });
      const convRes = await request(alice.token, `/bots/${bot.id}/conversations`, {});
      const conv = (await convRes.json()) as { id: string };

      const msgRes = await request(alice.token, `/conversations/${conv.id}/messages`, {
        clientMessageId: `worker-repeated-signals-${randomUUID()}`,
        content: "Job in progress during repeated stop signals",
      });
      const msg = (await msgRes.json()) as { jobId: string };

      const workerProc = spawnWorkerProcess({
        WORKER_BOT_ID: bot.id,
        SHUTDOWN_TIMEOUT_MS: "3000",
      });

      try {
        await waitForJobState(alice.token, msg.jobId, "running");

        // Send repeated stop signals
        workerProc.process.kill("SIGTERM");
        workerProc.process.kill("SIGINT");
        workerProc.process.kill("SIGTERM");

        const exit = await workerProc.waitForExit();
        expect(exit.code).toBe(0);

        const jobRes = await request(alice.token, `/jobs/${msg.jobId}`);
        const job = (await jobRes.json()) as { status: string };
        expect(job.status).toBe("succeeded");

        const msgsRes = await request(alice.token, `/conversations/${conv.id}/messages`);
        const msgs = (await msgsRes.json()) as Array<{ content: string; botId: string | null }>;
        expect(msgs).toHaveLength(2);
        expect(msgs[1]?.botId).toBe(bot.id);
      } finally {
        try {
          workerProc.process.kill("SIGKILL");
        } catch {}
      }
    });

    it("repeated stop signals during API shutdown with a request in progress do not crash or close db pool twice", async () => {
      const alice = await createUserWithToken();

      const apiProc = spawnApiProcess({ SHUTDOWN_TIMEOUT_MS: "3000" });
      await waitForApi(apiProc.url);

      const req = http.request(`${apiProc.url}/bots`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${alice.token}`,
          "content-type": "application/json",
        },
      });

      // Ensure TCP connection is established before sending signals
      await new Promise<void>((resolve) => {
        req.on("socket", (socket) => {
          if (socket.connecting) {
            socket.once("connect", () => resolve());
          } else {
            resolve();
          }
        });
      });

      // Write partial body so request is in progress in Hono
      req.write('{"name": "InFlightBot"');
      await new Promise((r) => setTimeout(r, 50));

      // Send repeated stop signals while request is in progress
      apiProc.process.kill("SIGTERM");
      apiProc.process.kill("SIGINT");
      apiProc.process.kill("SIGTERM");

      // Complete the request payload
      req.end(', "runtimeId": "fake"}');

      const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
        req.on("response", resolve);
        req.on("error", reject);
      });

      expect(res.statusCode).toBe(201);
      res.resume();

      const exit = await apiProc.waitForExit();
      expect(exit.code).toBe(0);
    });
  });
});
