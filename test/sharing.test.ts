import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createUserWithToken, request } from "./helpers.ts";

const validBot = {
  name: "SharedAssistant",
  runtimeId: "fake",
  runtimeSettings: { model: "claude-3-opus", temperature: 0.7 },
};

async function createBotFor(user: { token: string }) {
  const response = await request(user.token, "/bots", validBot);
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; name: string };
}

describe("sharing and conversation privacy", () => {
  it("an Owner can grant Member access to another User and list the grants on their Bot", async () => {
    const owner = await createUserWithToken();
    const member = await createUserWithToken();
    const bot = await createBotFor(owner);

    const grantResponse = await request(owner.token, `/bots/${bot.id}/grants`, {
      userName: member.name,
      role: "member",
    });
    expect(grantResponse.status).toBe(201);
    const grant = (await grantResponse.json()) as {
      botId: string;
      userId: string;
      role: string;
      createdAt: string;
    };
    expect(grant.botId).toBe(bot.id);
    expect(grant.role).toBe("member");

    const grantsListResponse = await request(owner.token, `/bots/${bot.id}/grants`);
    expect(grantsListResponse.status).toBe(200);
    const grantsList = (await grantsListResponse.json()) as Array<{
      botId: string;
      userId: string;
      role: string;
    }>;
    expect(grantsList).toHaveLength(2);
    expect(grantsList).toContainEqual(expect.objectContaining({ botId: bot.id, role: "owner" }));
    expect(grantsList).toContainEqual(
      expect.objectContaining({ botId: bot.id, userId: grant.userId, role: "member" }),
    );

    const duplicateResponse = await request(owner.token, `/bots/${bot.id}/grants`, {
      userName: member.name,
    });
    expect([200, 201]).toContain(duplicateResponse.status);
    expect(await duplicateResponse.json()).toEqual(grant);

    const ownerGrant = grantsList.find((g) => g.role === "owner")!;
    const selfRevokeResponse = await request(
      owner.token,
      `/bots/${bot.id}/grants/${ownerGrant.userId}`,
      undefined,
      "DELETE",
    );
    expect(selfRevokeResponse.status).toBe(400);
  });

  it("granting access is rejected for unknown target, self-grant, or invalid role", async () => {
    const owner = await createUserWithToken();
    const bot = await createBotFor(owner);

    const unknownNameResponse = await request(owner.token, `/bots/${bot.id}/grants`, {
      userName: "non-existent-user",
    });
    expect(unknownNameResponse.status).toBe(404);

    const selfGrantResponse = await request(owner.token, `/bots/${bot.id}/grants`, {
      userName: owner.name,
    });
    expect(selfGrantResponse.status).toBe(400);

    const invalidRoleResponse = await request(owner.token, `/bots/${bot.id}/grants`, {
      userName: "someone",
      role: "owner",
    });
    expect(invalidRoleResponse.status).toBe(400);

    const missingNameResponse = await request(owner.token, `/bots/${bot.id}/grants`, {});
    expect(missingNameResponse.status).toBe(400);
  });

  it("a Member sees the shared Bot in their Bot list and can create Conversations and post messages", async () => {
    const owner = await createUserWithToken();
    const member = await createUserWithToken();
    const bot = await createBotFor(owner);

    await request(owner.token, `/bots/${bot.id}/grants`, { userName: member.name });

    const memberBotsResponse = await request(member.token, "/bots");
    expect(memberBotsResponse.status).toBe(200);
    const memberBots = (await memberBotsResponse.json()) as Array<{ id: string; name: string }>;
    expect(memberBots.map((b) => b.id)).toContain(bot.id);

    const memberGetBotResponse = await request(member.token, `/bots/${bot.id}`);
    expect(memberGetBotResponse.status).toBe(200);
    expect(((await memberGetBotResponse.json()) as { id: string }).id).toBe(bot.id);

    const convResponse = await request(member.token, `/bots/${bot.id}/conversations`, {});
    expect(convResponse.status).toBe(201);
    const conv = (await convResponse.json()) as { id: string; botId: string };
    expect(conv.botId).toBe(bot.id);

    const msgResponse = await request(member.token, `/conversations/${conv.id}/messages`, {
      clientMessageId: "member-msg-1",
      content: "Hello from Member!",
    });
    expect(msgResponse.status).toBe(201);
    const msg = (await msgResponse.json()) as { id: string; jobId: string; content: string };
    expect(msg.content).toBe("Hello from Member!");
    expect(typeof msg.jobId).toBe("string");

    const messagesListResponse = await request(member.token, `/conversations/${conv.id}/messages`);
    expect(messagesListResponse.status).toBe(200);
    const messages = await messagesListResponse.json();
    expect(messages).toEqual([msg]);

    const jobResponse = await request(member.token, `/jobs/${msg.jobId}`);
    expect(jobResponse.status).toBe(200);
    expect(((await jobResponse.json()) as { id: string }).id).toBe(msg.jobId);
  });

  it("the Owner cannot list or read the Member's Conversations, and the Member cannot read the Owner's", async () => {
    const owner = await createUserWithToken();
    const member = await createUserWithToken();
    const bot = await createBotFor(owner);

    await request(owner.token, `/bots/${bot.id}/grants`, { userName: member.name });

    const ownerConvRes = await request(owner.token, `/bots/${bot.id}/conversations`, {});
    const ownerConv = (await ownerConvRes.json()) as { id: string };

    const memberConvRes = await request(member.token, `/bots/${bot.id}/conversations`, {});
    const memberConv = (await memberConvRes.json()) as { id: string };

    const ownerListRes = await request(owner.token, `/bots/${bot.id}/conversations`);
    expect(ownerListRes.status).toBe(200);
    const ownerList = (await ownerListRes.json()) as Array<{ id: string }>;
    expect(ownerList.map((c) => c.id)).toContain(ownerConv.id);
    expect(ownerList.map((c) => c.id)).not.toContain(memberConv.id);

    const memberListRes = await request(member.token, `/bots/${bot.id}/conversations`);
    expect(memberListRes.status).toBe(200);
    const memberList = (await memberListRes.json()) as Array<{ id: string }>;
    expect(memberList.map((c) => c.id)).toContain(memberConv.id);
    expect(memberList.map((c) => c.id)).not.toContain(ownerConv.id);

    expect((await request(owner.token, `/conversations/${memberConv.id}`)).status).toBe(404);
    expect((await request(member.token, `/conversations/${ownerConv.id}`)).status).toBe(404);

    expect(
      (
        await request(owner.token, `/conversations/${memberConv.id}/messages`, {
          clientMessageId: "snoop-1",
          content: "Trying to post",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(member.token, `/conversations/${ownerConv.id}/messages`, {
          clientMessageId: "snoop-2",
          content: "Trying to post",
        })
      ).status,
    ).toBe(404);

    expect((await request(owner.token, `/conversations/${memberConv.id}/messages`)).status).toBe(
      404,
    );
    expect((await request(member.token, `/conversations/${ownerConv.id}/messages`)).status).toBe(
      404,
    );
  });

  it("a Member cannot share, list or revoke grants on the Bot", async () => {
    const owner = await createUserWithToken();
    const member = await createUserWithToken();
    const charlie = await createUserWithToken();
    const bot = await createBotFor(owner);

    const grantRes = await request(owner.token, `/bots/${bot.id}/grants`, {
      userName: member.name,
    });
    const grant = (await grantRes.json()) as { userId: string };

    const shareRes = await request(member.token, `/bots/${bot.id}/grants`, {
      userName: charlie.name,
    });
    expect(shareRes.status).toBe(404);

    const listGrantsRes = await request(member.token, `/bots/${bot.id}/grants`);
    expect(listGrantsRes.status).toBe(404);

    const revokeRes = await request(
      member.token,
      `/bots/${bot.id}/grants/${grant.userId}`,
      undefined,
      "DELETE",
    );
    expect(revokeRes.status).toBe(404);
  });

  it("after revocation, the former Member's new posts are rejected and the Bot disappears from their list", async () => {
    const owner = await createUserWithToken();
    const member = await createUserWithToken();
    const bot = await createBotFor(owner);

    const grantRes = await request(owner.token, `/bots/${bot.id}/grants`, {
      userName: member.name,
    });
    const grant = (await grantRes.json()) as { userId: string };

    const convRes = await request(member.token, `/bots/${bot.id}/conversations`, {});
    const conv = (await convRes.json()) as { id: string };

    const msgRes = await request(member.token, `/conversations/${conv.id}/messages`, {
      clientMessageId: "pre-revocation-msg",
      content: "Message before revocation",
    });
    expect(msgRes.status).toBe(201);

    const revokeRes = await request(
      owner.token,
      `/bots/${bot.id}/grants/${grant.userId}`,
      undefined,
      "DELETE",
    );
    expect(revokeRes.status).toBe(200);

    const memberBotsRes = await request(member.token, "/bots");
    expect(memberBotsRes.status).toBe(200);
    const memberBots = (await memberBotsRes.json()) as Array<{ id: string }>;
    expect(memberBots.map((b) => b.id)).not.toContain(bot.id);

    expect((await request(member.token, `/bots/${bot.id}`)).status).toBe(404);

    const newConvRes = await request(member.token, `/bots/${bot.id}/conversations`, {});
    expect(newConvRes.status).toBe(404);

    const newMsgRes = await request(member.token, `/conversations/${conv.id}/messages`, {
      clientMessageId: "post-revocation-msg",
      content: "This message should be rejected",
    });
    expect(newMsgRes.status).toBe(404);

    const duplicateMsgRes = await request(member.token, `/conversations/${conv.id}/messages`, {
      clientMessageId: "pre-revocation-msg",
      content: "Message before revocation repeated",
    });
    expect(duplicateMsgRes.status).toBe(404);
  });

  it("a User without a grant gets not found for the Bot, its Conversations and its Jobs", async () => {
    const owner = await createUserWithToken();
    const member = await createUserWithToken();
    const stranger = await createUserWithToken();
    const bot = await createBotFor(owner);

    const grantRes = await request(owner.token, `/bots/${bot.id}/grants`, {
      userName: member.name,
    });
    const grant = (await grantRes.json()) as { userId: string };

    const convRes = await request(member.token, `/bots/${bot.id}/conversations`, {});
    const conv = (await convRes.json()) as { id: string };

    const msgRes = await request(member.token, `/conversations/${conv.id}/messages`, {
      clientMessageId: "msg-1",
      content: "Hello",
    });
    const msg = (await msgRes.json()) as { jobId: string };

    expect((await request(stranger.token, `/bots/${bot.id}`)).status).toBe(404);
    expect((await request(stranger.token, `/bots/${bot.id}/conversations`)).status).toBe(404);
    expect((await request(stranger.token, `/bots/${bot.id}/conversations`, {})).status).toBe(404);
    expect((await request(stranger.token, `/conversations/${conv.id}`)).status).toBe(404);
    expect(
      (
        await request(stranger.token, `/conversations/${conv.id}/messages`, {
          clientMessageId: "stranger-1",
          content: "Hello",
        })
      ).status,
    ).toBe(404);
    expect((await request(stranger.token, `/conversations/${conv.id}/messages`)).status).toBe(404);
    expect((await request(stranger.token, `/jobs/${msg.jobId}`)).status).toBe(404);

    await request(owner.token, `/bots/${bot.id}/grants/${grant.userId}`, undefined, "DELETE");

    expect((await request(member.token, `/bots/${bot.id}`)).status).toBe(404);
    expect((await request(member.token, `/conversations/${conv.id}`)).status).toBe(404);
    expect((await request(member.token, `/conversations/${conv.id}/messages`)).status).toBe(404);
    expect((await request(member.token, `/jobs/${msg.jobId}`)).status).toBe(404);

    const unknownRevokeRes = await request(
      owner.token,
      `/bots/${bot.id}/grants/${randomUUID()}`,
      undefined,
      "DELETE",
    );
    expect(unknownRevokeRes.status).toBe(404);

    const alreadyRevokedRes = await request(
      owner.token,
      `/bots/${bot.id}/grants/${grant.userId}`,
      undefined,
      "DELETE",
    );
    expect(alreadyRevokedRes.status).toBe(404);
  });
});
