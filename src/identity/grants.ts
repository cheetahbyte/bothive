import { and, eq } from "drizzle-orm";
import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { accessGrants, users } from "../db/schema.ts";
import { getBotAccessRole } from "./bots.ts";

export const accessGrantSchema = createSelectSchema(accessGrants);

export type AccessGrant = typeof accessGrants.$inferSelect;

export const createAccessGrantSchema = z.object({
  userName: z.string().trim().min(1),
  role: z.literal("member").optional(),
});

export type CreateAccessGrantInput = z.infer<typeof createAccessGrantSchema>;

export type GrantAccessResult =
  | { success: true; grant: AccessGrant }
  | { success: false; error: "not_found" | "forbidden" | "target_not_found" | "invalid_target" };

export async function grantAccess(
  db: Db,
  callerId: string,
  botId: string,
  input: CreateAccessGrantInput,
): Promise<GrantAccessResult> {
  const callerRole = await getBotAccessRole(db, callerId, botId);
  if (!callerRole) return { success: false, error: "not_found" };
  if (callerRole !== "owner") return { success: false, error: "forbidden" };

  const [targetUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.name, input.userName));
  if (!targetUser) return { success: false, error: "target_not_found" };

  if (targetUser.id === callerId) {
    return { success: false, error: "invalid_target" };
  }

  const [row] = await db
    .insert(accessGrants)
    .values({ botId, userId: targetUser.id, role: "member" })
    .onConflictDoNothing({ target: [accessGrants.botId, accessGrants.userId] })
    .returning();

  if (row) {
    return { success: true, grant: accessGrantSchema.parse(row) };
  }

  const [existing] = await db
    .select()
    .from(accessGrants)
    .where(and(eq(accessGrants.botId, botId), eq(accessGrants.userId, targetUser.id)));
  return { success: true, grant: accessGrantSchema.parse(existing!) };
}

export type ListAccessGrantsResult =
  | { success: true; grants: AccessGrant[] }
  | { success: false; error: "not_found" | "forbidden" };

export async function listAccessGrants(
  db: Db,
  callerId: string,
  botId: string,
): Promise<ListAccessGrantsResult> {
  const callerRole = await getBotAccessRole(db, callerId, botId);
  if (!callerRole) return { success: false, error: "not_found" };
  if (callerRole !== "owner") return { success: false, error: "forbidden" };

  const rows = await db
    .select()
    .from(accessGrants)
    .where(eq(accessGrants.botId, botId))
    .orderBy(accessGrants.createdAt);

  return { success: true, grants: rows.map((r) => accessGrantSchema.parse(r)) };
}

export type RevokeAccessResult =
  | { success: true }
  | { success: false; error: "not_found" | "forbidden" | "invalid_target" };

export async function revokeAccess(
  db: Db,
  callerId: string,
  botId: string,
  targetUserId: string,
): Promise<RevokeAccessResult> {
  const callerRole = await getBotAccessRole(db, callerId, botId);
  if (!callerRole) return { success: false, error: "not_found" };
  if (callerRole !== "owner") return { success: false, error: "forbidden" };

  if (targetUserId === callerId) {
    return { success: false, error: "invalid_target" };
  }

  const deleted = await db
    .delete(accessGrants)
    .where(
      and(
        eq(accessGrants.botId, botId),
        eq(accessGrants.userId, targetUserId),
        eq(accessGrants.role, "member"),
      ),
    )
    .returning();

  if (deleted.length === 0) {
    return { success: false, error: "not_found" };
  }

  return { success: true };
}
