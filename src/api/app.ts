import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import {
  createConversation,
  getConversation,
  listConversations,
} from "../conversations/conversations.ts";
import { getJob } from "../conversations/jobs.ts";
import { createMessage, createMessageSchema, listMessages } from "../conversations/messages.ts";
import { createBot, createBotSchema, getBot, listBots } from "../identity/bots.ts";
import {
  createAccessGrantSchema,
  grantAccess,
  listAccessGrants,
  revokeAccess,
} from "../identity/grants.ts";
import { authenticate } from "../identity/users.ts";

type Env = { Variables: { userId: string } };

const notFound = { error: "not_found" } as const;

export function createApp(db: Db) {
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    const match = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
    const user = match ? await authenticate(db, match[1]!) : null;
    if (!user) return c.json({ error: "unauthorized" }, 401);
    c.set("userId", user.id);
    await next();
  });

  app.post("/bots", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const input = createBotSchema.safeParse(body);
    if (!input.success) {
      return c.json({ error: "invalid_request", issues: z.treeifyError(input.error) }, 400);
    }
    return c.json(await createBot(db, c.get("userId"), input.data), 201);
  });

  app.get("/bots", async (c) => c.json(await listBots(db, c.get("userId"))));

  app.get("/bots/:id", async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    const bot = id.success ? await getBot(db, c.get("userId"), id.data) : null;
    return bot ? c.json(bot) : c.json(notFound, 404);
  });

  app.get("/bots/:botId/grants", async (c) => {
    const botId = z.uuid().safeParse(c.req.param("botId"));
    if (!botId.success) return c.json(notFound, 404);
    const result = await listAccessGrants(db, c.get("userId"), botId.data);
    if (!result.success) return c.json(notFound, 404);
    return c.json(result.grants);
  });

  app.post("/bots/:botId/grants", async (c) => {
    const botId = z.uuid().safeParse(c.req.param("botId"));
    if (!botId.success) return c.json(notFound, 404);

    const body: unknown = await c.req.json().catch(() => null);
    const input = createAccessGrantSchema.safeParse(body);
    if (!input.success) {
      return c.json({ error: "invalid_request", issues: z.treeifyError(input.error) }, 400);
    }

    const result = await grantAccess(db, c.get("userId"), botId.data, input.data);
    if (!result.success) {
      if (result.error === "invalid_target") {
        return c.json({ error: "invalid_request" }, 400);
      }
      return c.json(notFound, 404);
    }
    return c.json(result.grant, 201);
  });

  app.delete("/bots/:botId/grants/:userId", async (c) => {
    const botId = z.uuid().safeParse(c.req.param("botId"));
    const userId = z.uuid().safeParse(c.req.param("userId"));
    if (!botId.success || !userId.success) return c.json(notFound, 404);

    const result = await revokeAccess(db, c.get("userId"), botId.data, userId.data);
    if (!result.success) {
      if (result.error === "invalid_target") {
        return c.json({ error: "invalid_request" }, 400);
      }
      return c.json(notFound, 404);
    }
    return c.json({ success: true });
  });

  app.post("/bots/:botId/conversations", async (c) => {
    const botId = z.uuid().safeParse(c.req.param("botId"));
    if (!botId.success) return c.json(notFound, 404);
    const conv = await createConversation(db, c.get("userId"), botId.data);
    return conv ? c.json(conv, 201) : c.json(notFound, 404);
  });

  app.get("/bots/:botId/conversations", async (c) => {
    const botId = z.uuid().safeParse(c.req.param("botId"));
    if (!botId.success) return c.json(notFound, 404);
    const list = await listConversations(db, c.get("userId"), botId.data);
    return list ? c.json(list) : c.json(notFound, 404);
  });

  app.get("/conversations/:id", async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    const conv = id.success ? await getConversation(db, c.get("userId"), id.data) : null;
    return conv ? c.json(conv) : c.json(notFound, 404);
  });

  app.post("/conversations/:conversationId/messages", async (c) => {
    const convId = z.uuid().safeParse(c.req.param("conversationId"));
    if (!convId.success) return c.json(notFound, 404);

    const body: unknown = await c.req.json().catch(() => null);
    const input = createMessageSchema.safeParse(body);
    if (!input.success) {
      return c.json({ error: "invalid_request", issues: z.treeifyError(input.error) }, 400);
    }

    const result = await createMessage(db, c.get("userId"), convId.data, input.data);
    return result ? c.json(result.message, 201) : c.json(notFound, 404);
  });

  app.get("/conversations/:conversationId/messages", async (c) => {
    const convId = z.uuid().safeParse(c.req.param("conversationId"));
    if (!convId.success) return c.json(notFound, 404);

    const rawCursor = c.req.query("cursor") ?? c.req.query("after");
    let cursor: string | undefined = undefined;
    if (rawCursor !== undefined) {
      const parsedCursor = z.uuid().safeParse(rawCursor);
      if (!parsedCursor.success) {
        return c.json({ error: "invalid_request" }, 400);
      }
      cursor = parsedCursor.data;
    }

    const result = await listMessages(db, c.get("userId"), convId.data, cursor);
    if (!result.success) {
      if (result.error === "not_found") return c.json(notFound, 404);
      return c.json({ error: "invalid_request" }, 400);
    }

    return c.json(result.messages);
  });

  app.get("/jobs/:id", async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    const job = id.success ? await getJob(db, c.get("userId"), id.data) : null;
    return job ? c.json(job) : c.json(notFound, 404);
  });

  app.notFound((c) => c.json(notFound, 404));

  return app;
}
