ALTER TABLE "jobs" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "lease_token" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "next_eligible_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "jobs_status_next_eligible_at_index" ON "jobs" USING btree ("status","next_eligible_at");--> statement-breakpoint
CREATE INDEX "jobs_status_lease_expires_at_index" ON "jobs" USING btree ("status","lease_expires_at");