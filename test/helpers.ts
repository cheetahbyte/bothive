import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/api/app.ts";
import { createDb } from "../src/db/client.ts";
import { fakeRuntime } from "../src/runtime/fake.ts";
import { createRuntimeRegistry, type RuntimeRegistry } from "../src/runtime/registry.ts";
import { createWorker, type WorkerOptions } from "../src/worker/worker.ts";
import { databaseUrl, runCli } from "./cli.ts";

export const { db, close } = createDb(databaseUrl);
export const testRegistry: RuntimeRegistry = createRuntimeRegistry([fakeRuntime]);
export const app = createApp(db, testRegistry);

export async function createUserWithToken() {
  const name = `user-${randomUUID()}`;
  const created = await runCli(["user", "create", name]);
  if (created.code !== 0) throw new Error(created.stderr);
  const issued = await runCli(["token", "issue", name]);
  if (issued.code !== 0) throw new Error(issued.stderr);
  const tokenId = /Token ID: (\S+)/.exec(issued.stdout)?.[1];
  const token = /Token \(shown once\): (\S+)/.exec(issued.stdout)?.[1];
  if (!tokenId || !token) throw new Error("unparseable token output");
  return { name, tokenId, token };
}

export function request(token: string | null, path: string, body?: unknown, method?: string) {
  const resolvedMethod = method ?? (body === undefined ? "GET" : "POST");
  return app.request(path, {
    method: resolvedMethod,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function startTestWorker(options?: WorkerOptions, registry: RuntimeRegistry = testRegistry) {
  const worker = createWorker(db, registry, {
    pollIntervalMs: 20,
    shutdownTimeoutMs: 0,
    ...options,
  });
  void worker.start();
  return worker;
}

export function spawnWorkerProcess(env?: Record<string, string>) {
  const proc = spawn(process.execPath, ["src/worker/main.ts"], {
    env: { PATH: process.env.PATH, DATABASE_URL: databaseUrl, ...env },
    stdio: "pipe",
  });
  return {
    process: proc,
    stop: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
        proc.on("exit", () => resolve());
        proc.kill("SIGTERM");
      }),
    waitForExit: () =>
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) {
          resolve({ code: proc.exitCode, signal: proc.signalCode });
        } else {
          proc.on("exit", (code, signal) => resolve({ code, signal }));
        }
      }),
  };
}

export function spawnApiProcess(env?: Record<string, string>) {
  const port = env?.PORT ?? String(3400 + Math.floor(Math.random() * 2000));
  const proc = spawn(process.execPath, ["src/api/main.ts"], {
    env: { PATH: process.env.PATH, DATABASE_URL: databaseUrl, PORT: port, ...env },
    stdio: "pipe",
  });
  let stderr = "";
  let stdout = "";
  proc.stderr?.on("data", (d) => {
    stderr += d.toString();
  });
  proc.stdout?.on("data", (d) => {
    stdout += d.toString();
  });
  return {
    port: Number(port),
    url: `http://localhost:${port}`,
    process: proc,
    getStderr: () => stderr,
    getStdout: () => stdout,
    stop: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
        proc.on("exit", () => resolve());
        proc.kill("SIGTERM");
      }),
    waitForExit: () =>
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) {
          resolve({ code: proc.exitCode, signal: proc.signalCode });
        } else {
          proc.on("exit", (code, signal) => resolve({ code, signal }));
        }
      }),
  };
}

export async function waitForApi(baseUrl: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // API process starting
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for API at ${baseUrl}`);
}

export async function waitForJob(
  token: string,
  jobId: string,
  timeoutMs = 5000,
): Promise<{
  id: string;
  status: string;
  attempt: number;
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
        attempt: number;
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
