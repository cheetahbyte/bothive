import { and, eq, sql } from "drizzle-orm";
import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { jobs, messages } from "../db/schema.ts";
import { getConversation } from "./conversations.ts";

export const messageSchema = createSelectSchema(messages);

export type Message = typeof messages.$inferSelect;

export const createMessageSchema = z.object({
  clientMessageId: z.string().trim().min(1).max(255),
  content: z.string().min(1),
});

export type CreateMessageInput = z.infer<typeof createMessageSchema>;

export async function createMessage(
  db: Db,
  userId: string,
  conversationId: string,
  input: CreateMessageInput,
) {
  const conv = await getConversation(db, userId, conversationId);
  if (!conv) return null;

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.clientMessageId, input.clientMessageId),
        ),
      );
    if (existing) {
      return { message: messageSchema.parse(existing), created: false };
    }

    const [job] = await tx
      .insert(jobs)
      .values({
        conversationId,
        userId,
        status: "queued",
      })
      .returning();

    const [msg] = await tx
      .insert(messages)
      .values({
        conversationId,
        userId,
        clientMessageId: input.clientMessageId,
        content: input.content,
        jobId: job!.id,
      })
      .returning();

    return { message: messageSchema.parse(msg), created: true };
  });
}

export type ListMessagesResult =
  | { success: true; messages: Message[] }
  | { success: false; error: "not_found" | "invalid_cursor" };

export async function listMessages(
  db: Db,
  userId: string,
  conversationId: string,
  cursorId?: string,
): Promise<ListMessagesResult> {
  const conv = await getConversation(db, userId, conversationId);
  if (!conv) return { success: false, error: "not_found" };

  if (cursorId) {
    const [cursorMsg] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.id, cursorId), eq(messages.conversationId, conversationId)));
    if (!cursorMsg) {
      return { success: false, error: "invalid_cursor" };
    }

    const rows = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          sql`(${messages.createdAt}, ${messages.id}) > (
            SELECT ${messages.createdAt}, ${messages.id}
            FROM ${messages}
            WHERE ${messages.id} = ${cursorId} AND ${messages.conversationId} = ${conversationId}
          )`,
        ),
      )
      .orderBy(messages.createdAt, messages.id);

    return { success: true, messages: rows.map((r) => messageSchema.parse(r)) };
  }

  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(messages.createdAt, messages.id);

  return { success: true, messages: rows.map((r) => messageSchema.parse(r)) };
}
