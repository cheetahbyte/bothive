import { and, eq, isNull } from "drizzle-orm";
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
  concurrencyLimit: z.number().int().min(1).default(4),
}).pick({ name: true, runtimeId: true, runtimeSettings: true, concurrencyLimit: true });

export type CreateBotInput = z.infer<typeof createBotSchema>;

export const updateBotSchema = z.strictObject({
  name: z.string().trim().min(1).max(100).optional(),
  runtimeId: z.string().trim().min(1).max(100).optional(),
  runtimeSettings: z.record(z.string(), z.unknown()).optional(),
  concurrencyLimit: z.number().int().min(1).optional(),
});

export type UpdateBotInput = z.infer<typeof updateBotSchema>;

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
    .where(and(eq(accessGrants.userId, userId), isNull(bots.deletedAt)))
    .orderBy(bots.createdAt);
  return rows.map((row) => botSchema.parse(row.bot));
}

export async function getBot(db: Db, userId: string, botId: string) {
  const [row] = await db
    .select({ bot: bots })
    .from(bots)
    .innerJoin(accessGrants, eq(accessGrants.botId, bots.id))
    .where(and(eq(bots.id, botId), eq(accessGrants.userId, userId), isNull(bots.deletedAt)));
  return row ? botSchema.parse(row.bot) : null;
}

export async function getBotAccessRole(db: Db, userId: string, botId: string) {
  const [grant] = await db
    .select({ role: accessGrants.role })
    .from(accessGrants)
    .innerJoin(bots, eq(bots.id, accessGrants.botId))
    .where(
      and(eq(accessGrants.botId, botId), eq(accessGrants.userId, userId), isNull(bots.deletedAt)),
    );
  return grant ? grant.role : null;
}

export type UpdateBotResult =
  | { success: true; bot: Bot }
  | { success: false; error: "not_found" | "forbidden" };

export async function updateBot(
  db: Db,
  userId: string,
  botId: string,
  input: UpdateBotInput,
): Promise<UpdateBotResult> {
  const role = await getBotAccessRole(db, userId, botId);
  if (!role) return { success: false, error: "not_found" };
  if (role !== "owner") return { success: false, error: "forbidden" };

  const updateValues: Partial<typeof bots.$inferInsert> = {};
  if (input.name !== undefined) updateValues.name = input.name;
  if (input.runtimeId !== undefined) updateValues.runtimeId = input.runtimeId;
  if (input.runtimeSettings !== undefined) updateValues.runtimeSettings = input.runtimeSettings;
  if (input.concurrencyLimit !== undefined) updateValues.concurrencyLimit = input.concurrencyLimit;

  if (Object.keys(updateValues).length === 0) {
    const current = await getBot(db, userId, botId);
    return current ? { success: true, bot: current } : { success: false, error: "not_found" };
  }

  const [updated] = await db
    .update(bots)
    .set(updateValues)
    .where(and(eq(bots.id, botId), isNull(bots.deletedAt)))
    .returning();

  if (!updated) return { success: false, error: "not_found" };
  return { success: true, bot: botSchema.parse(updated) };
}

export type DisableBotResult =
  | { success: true; bot: Bot }
  | { success: false; error: "not_found" | "forbidden" };

export async function disableBot(db: Db, userId: string, botId: string): Promise<DisableBotResult> {
  const role = await getBotAccessRole(db, userId, botId);
  if (!role) return { success: false, error: "not_found" };
  if (role !== "owner") return { success: false, error: "forbidden" };

  const [updated] = await db
    .update(bots)
    .set({ disabledAt: new Date() })
    .where(and(eq(bots.id, botId), isNull(bots.deletedAt)))
    .returning();

  if (!updated) return { success: false, error: "not_found" };
  return { success: true, bot: botSchema.parse(updated) };
}

export type EnableBotResult =
  | { success: true; bot: Bot }
  | { success: false; error: "not_found" | "forbidden" };

export async function enableBot(db: Db, userId: string, botId: string): Promise<EnableBotResult> {
  const role = await getBotAccessRole(db, userId, botId);
  if (!role) return { success: false, error: "not_found" };
  if (role !== "owner") return { success: false, error: "forbidden" };

  const [updated] = await db
    .update(bots)
    .set({ disabledAt: null })
    .where(and(eq(bots.id, botId), isNull(bots.deletedAt)))
    .returning();

  if (!updated) return { success: false, error: "not_found" };
  return { success: true, bot: botSchema.parse(updated) };
}

export type DeleteBotResult =
  | { success: true }
  | { success: false; error: "not_found" | "forbidden" };

export async function deleteBot(db: Db, userId: string, botId: string): Promise<DeleteBotResult> {
  const role = await getBotAccessRole(db, userId, botId);
  if (!role) return { success: false, error: "not_found" };
  if (role !== "owner") return { success: false, error: "forbidden" };

  const [updated] = await db
    .update(bots)
    .set({ deletedAt: new Date() })
    .where(and(eq(bots.id, botId), isNull(bots.deletedAt)))
    .returning();

  if (!updated) return { success: false, error: "not_found" };
  return { success: true };
}
