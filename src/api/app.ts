import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { createBot, createBotSchema, getBot, listBots } from "../identity/bots.ts";
import { authenticate } from "../identity/users.ts";

type Env = { Variables: { userId: string } };

const notFound = { error: "not_found" } as const;

export function createApp(db: Db) {
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    const match = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "");
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

  app.notFound((c) => c.json(notFound, 404));

  return app;
}
