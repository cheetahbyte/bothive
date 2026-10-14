import { and, eq } from "drizzle-orm";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { accessGrants, bots } from "../db/schema.ts";

export const botSchema = createSelectSchema(bots);

export type Bot = typeof bots.$inferSelect;

export const createBotSchema = createInsertSchema(bots, {
  name: (schema) => schema.trim().min(1).max(100),
  runtimeId: (schema) => schema.trim().min(1).max(100),
  runtimeSettings: z.record(z.string(), z.unknown()).default({}),
}).pick({ name: true, runtimeId: true, runtimeSettings: true });

export type CreateBotInput = z.infer<typeof createBotSchema>;

export async function createBot(db: Db, ownerId: string, input: CreateBotInput) {
  return db.transaction(async (tx) => {
    const [bot] = await tx.insert(bots).values(input).returning();
    await tx.insert(accessGrants).values({ botId: bot!.id, userId: ownerId, role: "owner" });
    return botSchema.parse(bot);
  });
}

export async function listBots(db: Db, userId: string) {
  const rows = await db
    .select({ bot: bots })
    .from(bots)
    .innerJoin(accessGrants, eq(accessGrants.botId, bots.id))
    .where(eq(accessGrants.userId, userId))
    .orderBy(bots.createdAt);
  return rows.map((row) => botSchema.parse(row.bot));
}

export async function getBot(db: Db, userId: string, botId: string) {
  const [row] = await db
    .select({ bot: bots })
    .from(bots)
    .innerJoin(accessGrants, eq(accessGrants.botId, bots.id))
    .where(and(eq(bots.id, botId), eq(accessGrants.userId, userId)));
  return row ? botSchema.parse(row.bot) : null;
}

export async function getBotAccessRole(db: Db, userId: string, botId: string) {
  const [grant] = await db
    .select({ role: accessGrants.role })
    .from(accessGrants)
    .where(and(eq(accessGrants.botId, botId), eq(accessGrants.userId, userId)));
  return grant ? grant.role : null;
}
