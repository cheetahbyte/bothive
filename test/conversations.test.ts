import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createUserWithToken, request } from "./helpers.ts";

const validBot = {
  name: "Helper",
  runtimeId: "fake",
  runtimeSettings: { model: "x", temperature: 0.2 },
};

async function createBotFor(user: { token: string }) {
  const response = await request(user.token, "/bots", validBot);
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; name: string };
}

describe("conversations", () => {
  it("a User can create several Conversations with the same Bot and list them", async () => {
    const alice = await createUserWithToken();
    const bot = await createBotFor(alice);

    const conv1Res = await request(alice.token, `/bots/${bot.id}/conversations`, {});
    expect(conv1Res.status).toBe(201);
    const conv1 = (await conv1Res.json()) as {
      id: string;
      botId: string;
      userId: string;
      createdAt: string;
    };
    expect(conv1.botId).toBe(bot.id);

    const conv2Res = await request(alice.token, `/bots/${bot.id}/conversations`, {});
    expect(conv2Res.status).toBe(201);
    const conv2 = (await conv2Res.json()) as {
      id: string;
      botId: string;
      userId: string;
      createdAt: string;
    };
    expect(conv2.botId).toBe(bot.id);
    expect(conv2.id).not.toBe(conv1.id);

    const listRes = await request(alice.token, `/bots/${bot.id}/conversations`);
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list).toEqual([conv1, conv2]);
  });

  it("a User gets a Conversation by ID", async () => {
    const alice = await createUserWithToken();
    const bot = await createBotFor(alice);

    const created = (await (
      await request(alice.token, `/bots/${bot.id}/conversations`, {})
    ).json()) as {
      id: string;
      botId: string;
    };

    const gotRes = await request(alice.token, `/conversations/${created.id}`);
    expect(gotRes.status).toBe(200);
    expect(await gotRes.json()).toEqual(created);
  });

  it("Conversations are private: another User cannot list or get them", async () => {
    const alice = await createUserWithToken();
    const bob = await createUserWithToken();
    const bot = await createBotFor(alice);

    const conv = (await (
      await request(alice.token, `/bots/${bot.id}/conversations`, {})
    ).json()) as { id: string };

    const got = await request(bob.token, `/conversations/${conv.id}`);
    expect(got.status).toBe(404);

    const unknown = await request(bob.token, `/conversations/${randomUUID()}`);
    expect(unknown.status).toBe(404);
    expect(await got.json()).toEqual(await unknown.json());
  });

  it("creating or listing Conversations on a Bot the User cannot access is rejected", async () => {
    const alice = await createUserWithToken();
    const bob = await createUserWithToken();
    const bot = await createBotFor(alice);

    const createRes = await request(bob.token, `/bots/${bot.id}/conversations`, {});
    expect(createRes.status).toBe(404);

    const listRes = await request(bob.token, `/bots/${bot.id}/conversations`);
    expect(listRes.status).toBe(404);
  });

  it("a malformed Conversation ID answers as not found", async () => {
    const alice = await createUserWithToken();
    expect((await request(alice.token, "/conversations/nope")).status).toBe(404);
  });

  it("posting a message requires a client message ID and returns the message and its Job ID immediately", async () => {
    const alice = await createUserWithToken();
    const bot = await createBotFor(alice);
    const conv = (await (
      await request(alice.token, `/bots/${bot.id}/conversations`, {})
    ).json()) as {
      id: string;
    };

    const res = await request(alice.token, `/conversations/${conv.id}/messages`, {
      clientMessageId: "client-msg-1",
      content: "Hello Bothive!",
    });
    expect(res.status).toBe(201);
    const msg = (await res.json()) as {
      id: string;
      conversationId: string;
      userId: string;
      clientMessageId: string;
      content: string;
      jobId: string;
      createdAt: string;
    };
    expect(msg.conversationId).toBe(conv.id);
    expect(msg.clientMessageId).toBe("client-msg-1");
    expect(msg.content).toBe("Hello Bothive!");
    expect(typeof msg.id).toBe("string");
    expect(typeof msg.jobId).toBe("string");
  });

  it("posting the same client message ID twice in a Conversation yields one message and one Job", async () => {
    const alice = await createUserWithToken();
    const bot = await createBotFor(alice);
    const conv = (await (
      await request(alice.token, `/bots/${bot.id}/conversations`, {})
    ).json()) as {
      id: string;
    };

    const firstRes = await request(alice.token, `/conversations/${conv.id}/messages`, {
      clientMessageId: "idempotent-msg",
      content: "First attempt",
    });
    expect(firstRes.status).toBe(201);
    const firstMsg = await firstRes.json();

    const secondRes = await request(alice.token, `/conversations/${conv.id}/messages`, {
      clientMessageId: "idempotent-msg",
      content: "Second attempt with different body",
    });
    expect([200, 201]).toContain(secondRes.status);
    const secondMsg = await secondRes.json();
    expect(secondMsg).toEqual(firstMsg);
  });

  it.each([
    ["missing clientMessageId", { content: "hello" }],
    ["blank clientMessageId", { clientMessageId: "   ", content: "hello" }],
    ["missing content", { clientMessageId: "msg-1" }],
    ["blank content", { clientMessageId: "msg-1", content: "" }],
    ["non-string content", { clientMessageId: "msg-1", content: 123 }],
  ])("rejects invalid message payload: %s", async (_label, body) => {
    const alice = await createUserWithToken();
    const bot = await createBotFor(alice);
    const conv = (await (
      await request(alice.token, `/bots/${bot.id}/conversations`, {})
    ).json()) as {
      id: string;
    };

    const res = await request(alice.token, `/conversations/${conv.id}/messages`, body);
    expect(res.status).toBe(400);
  });

  it("posting to a Conversation another User owns or cannot access is rejected with 404", async () => {
    const alice = await createUserWithToken();
    const bob = await createUserWithToken();
    const bot = await createBotFor(alice);
    const conv = (await (
      await request(alice.token, `/bots/${bot.id}/conversations`, {})
    ).json()) as {
      id: string;
    };

    const res = await request(bob.token, `/conversations/${conv.id}/messages`, {
      clientMessageId: "msg-from-bob",
      content: "Hacking...",
    });
    expect(res.status).toBe(404);

    const unknown = await request(bob.token, `/conversations/${randomUUID()}/messages`, {
      clientMessageId: "msg-1",
      content: "test",
    });
    expect(unknown.status).toBe(404);
  });

  it("messages can be listed without a cursor in the order they were posted", async () => {
    const alice = await createUserWithToken();
    const bot = await createBotFor(alice);
    const conv = (await (
      await request(alice.token, `/bots/${bot.id}/conversations`, {})
    ).json()) as {
      id: string;
    };

    const res1 = await request(alice.token, `/conversations/${conv.id}/messages`, {
      clientMessageId: "m1",
      content: "First",
    });
    const res2 = await request(alice.token, `/conversations/${conv.id}/messages`, {
      clientMessageId: "m2",
      content: "Second",
    });
    const res3 = await request(alice.token, `/conversations/${conv.id}/messages`, {
      clientMessageId: "m3",
      content: "Third",
    });

    const msg1 = await res1.json();
    const msg2 = await res2.json();
    const msg3 = await res3.json();

    const listRes = await request(alice.token, `/conversations/${conv.id}/messages`);
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list).toEqual([msg1, msg2, msg3]);
  });

  it("messages can be listed after a cursor (?cursor or ?after)", async () => {
    const alice = await createUserWithToken();
    const bot = await createBotFor(alice);
    const conv = (await (
      await request(alice.token, `/bots/${bot.id}/conversations`, {})
    ).json()) as {
      id: string;
    };

    const res1 = await request(alice.token, `/conversations/${conv.id}/messages`, {
      clientMessageId: "c1",
      content: "One",
    });
    const res2 = await request(alice.token, `/conversations/${conv.id}/messages`, {
      clientMessageId: "c2",
      content: "Two",
    });
    const res3 = await request(alice.token, `/conversations/${conv.id}/messages`, {
      clientMessageId: "c3",
      content: "Three",
    });

    const msg1 = (await res1.json()) as { id: string };
    const msg2 = (await res2.json()) as { id: string };
    const msg3 = (await res3.json()) as { id: string };

    const afterCursor1 = await request(
      alice.token,
      `/conversations/${conv.id}/messages?cursor=${msg1.id}`,
    );
    expect(afterCursor1.status).toBe(200);
    expect(await afterCursor1.json()).toEqual([msg2, msg3]);

    const afterParam1 = await request(
      alice.token,
      `/conversations/${conv.id}/messages?after=${msg1.id}`,
    );
    expect(afterParam1.status).toBe(200);
    expect(await afterParam1.json()).toEqual([msg2, msg3]);

    const afterCursor2 = await request(
      alice.token,
      `/conversations/${conv.id}/messages?cursor=${msg2.id}`,
    );
    expect(afterCursor2.status).toBe(200);
    expect(await afterCursor2.json()).toEqual([msg3]);

    const afterCursor3 = await request(
      alice.token,
      `/conversations/${conv.id}/messages?cursor=${msg3.id}`,
    );
    expect(afterCursor3.status).toBe(200);
    expect(await afterCursor3.json()).toEqual([]);
  });

  it("listing messages is rejected if user cannot access or conversation does not exist", async () => {
    const alice = await createUserWithToken();
    const bob = await createUserWithToken();
    const bot = await createBotFor(alice);
    const conv = (await (
      await request(alice.token, `/bots/${bot.id}/conversations`, {})
    ).json()) as {
      id: string;
    };

    const got = await request(bob.token, `/conversations/${conv.id}/messages`);
    expect(got.status).toBe(404);

    const unknown = await request(bob.token, `/conversations/${randomUUID()}/messages`);
    expect(unknown.status).toBe(404);

    const malformed = await request(bob.token, "/conversations/nope/messages");
    expect(malformed.status).toBe(404);
  });

  it("listing messages with an invalid or unknown cursor returns 400", async () => {
    const alice = await createUserWithToken();
    const bot = await createBotFor(alice);
    const conv = (await (
      await request(alice.token, `/bots/${bot.id}/conversations`, {})
    ).json()) as {
      id: string;
    };

    const malformedCursor = await request(
      alice.token,
      `/conversations/${conv.id}/messages?cursor=invalid-uuid`,
    );
    expect(malformedCursor.status).toBe(400);

    const unknownCursor = await request(
      alice.token,
      `/conversations/${conv.id}/messages?cursor=${randomUUID()}`,
    );
    expect(unknownCursor.status).toBe(400);
  });

  it("the Job created by posting a message is readable by ID by the message author and shows status queued", async () => {
    const alice = await createUserWithToken();
    const bot = await createBotFor(alice);
    const conv = (await (
      await request(alice.token, `/bots/${bot.id}/conversations`, {})
    ).json()) as {
      id: string;
    };

    const msgRes = await request(alice.token, `/conversations/${conv.id}/messages`, {
      clientMessageId: "job-test-msg",
      content: "Hello Job",
    });
    const msg = (await msgRes.json()) as { jobId: string };

    const jobRes = await request(alice.token, `/jobs/${msg.jobId}`);
    expect(jobRes.status).toBe(200);
    const job = (await jobRes.json()) as {
      id: string;
      status: string;
      conversationId: string;
      userId: string;
    };
    expect(job.id).toBe(msg.jobId);
    expect(job.status).toBe("queued");
  });

  it("Jobs are private: another User cannot read the Job", async () => {
    const alice = await createUserWithToken();
    const bob = await createUserWithToken();
    const bot = await createBotFor(alice);
    const conv = (await (
      await request(alice.token, `/bots/${bot.id}/conversations`, {})
    ).json()) as {
      id: string;
    };

    const msgRes = await request(alice.token, `/conversations/${conv.id}/messages`, {
      clientMessageId: "private-job-msg",
      content: "Secret Job",
    });
    const msg = (await msgRes.json()) as { jobId: string };

    const got = await request(bob.token, `/jobs/${msg.jobId}`);
    expect(got.status).toBe(404);

    const unknown = await request(bob.token, `/jobs/${randomUUID()}`);
    expect(unknown.status).toBe(404);
    expect(await got.json()).toEqual(await unknown.json());
  });

  it("a malformed Job ID answers as not found", async () => {
    const alice = await createUserWithToken();
    expect((await request(alice.token, "/jobs/not-a-uuid")).status).toBe(404);
  });
});
