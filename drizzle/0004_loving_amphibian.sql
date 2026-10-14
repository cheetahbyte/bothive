ALTER TABLE "bots" ADD COLUMN "concurrency_limit" integer DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "deleted_at" timestamp with time zone;