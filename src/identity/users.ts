import { and, eq, isNull } from "drizzle-orm";
import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { apiTokens, users } from "../db/schema.ts";
import { generateApiToken, hashApiToken } from "./tokens.ts";

export const userSchema = createSelectSchema(users);

export const userNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^\P{Cc}+$/u, "must not contain control characters");

export async function createUser(db: Db, name: string) {
  const [row] = await db
    .insert(users)
    .values({ name: userNameSchema.parse(name) })
    .returning();
  return userSchema.parse(row);
}

export async function listUsers(db: Db) {
  const rows = await db.select().from(users).orderBy(users.createdAt);
  return rows.map((row) => userSchema.parse(row));
}

export async function issueApiToken(db: Db, userName: string) {
  const [user] = await db.select().from(users).where(eq(users.name, userName));
  if (!user) return null;
  const token = generateApiToken();
  const [row] = await db
    .insert(apiTokens)
    .values({ userId: user.id, tokenHash: hashApiToken(token) })
    .returning({ id: apiTokens.id });
  return { id: row!.id, token };
}

export async function revokeApiToken(db: Db, tokenId: string) {
  if (!z.uuid().safeParse(tokenId).success) return false;
  const revoked = await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, tokenId), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id });
  return revoked.length > 0;
}

export async function authenticate(db: Db, token: string) {
  const [row] = await db
    .select({ id: users.id, name: users.name })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(and(eq(apiTokens.tokenHash, hashApiToken(token)), isNull(apiTokens.revokedAt)));
  return row ?? null;
}
