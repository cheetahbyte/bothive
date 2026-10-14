import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull().unique(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    tokenHash: text().notNull().unique(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (table) => [index().on(table.userId)],
);

export const bots = pgTable("bots", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  runtimeId: text().notNull(),
  runtimeSettings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const accessRole = pgEnum("access_role", ["owner", "member"]);

export const accessGrants = pgTable(
  "access_grants",
  {
    botId: uuid()
      .notNull()
      .references(() => bots.id),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    role: accessRole().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.botId, table.userId] }),
    uniqueIndex()
      .on(table.botId)
      .where(sql`${table.role} = 'owner'`),
    index().on(table.userId),
  ],
);
