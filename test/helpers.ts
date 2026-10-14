import { randomUUID } from "node:crypto";
import { createApp } from "../src/api/app.ts";
import { createDb } from "../src/db/client.ts";
import { databaseUrl, runCli } from "./cli.ts";

export const { db, close } = createDb(databaseUrl);
export const app = createApp(db);

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
