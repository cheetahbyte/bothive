import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { describe, expect, it } from "vitest";
import type { botSchema } from "../src/identity/bots.ts";
import { createUserWithToken, request } from "./helpers.ts";

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
});
