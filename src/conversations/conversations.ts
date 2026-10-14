import { and, eq } from "drizzle-orm";
import { createSelectSchema } from "drizzle-zod";
import type { Db } from "../db/client.ts";
import { accessGrants, conversations } from "../db/schema.ts";
import { getBot } from "../identity/bots.ts";

export const conversationSchema = createSelectSchema(conversations);

export type Conversation = typeof conversations.$inferSelect;

export async function createConversation(db: Db, userId: string, botId: string) {
  const bot = await getBot(db, userId, botId);
  if (!bot) return null;

  const [row] = await db.insert(conversations).values({ botId, userId }).returning();
  return row ? conversationSchema.parse(row) : null;
}

export async function listConversations(db: Db, userId: string, botId: string) {
  const bot = await getBot(db, userId, botId);
  if (!bot) return null;

  const rows = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.botId, botId), eq(conversations.userId, userId)))
    .orderBy(conversations.createdAt);
  return rows.map((r) => conversationSchema.parse(r));
}

export async function getConversation(db: Db, userId: string, conversationId: string) {
  const [row] = await db
    .select({ conversation: conversations })
    .from(conversations)
    .innerJoin(
      accessGrants,
      and(
        eq(accessGrants.botId, conversations.botId),
        eq(accessGrants.userId, conversations.userId),
      ),
    )
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)));
  return row ? conversationSchema.parse(row.conversation) : null;
}
