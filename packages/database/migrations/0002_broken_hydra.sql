CREATE TABLE "analysis_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"work_item_id" text NOT NULL,
	"request_key" text NOT NULL,
	"request" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analysis_jobs_request_unique" UNIQUE("owner_id","repository_id","work_item_id","request_key"),
	CONSTRAINT "analysis_jobs_status_check" CHECK ("analysis_jobs"."status" IN ('queued', 'running', 'succeeded', 'failed', 'needs_input'))
);
--> statement-breakpoint
CREATE INDEX "analysis_jobs_dispatch_idx" ON "analysis_jobs" USING btree ("status","created_at");