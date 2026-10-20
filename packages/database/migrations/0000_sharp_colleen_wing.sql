CREATE TYPE "public"."repository_provider" AS ENUM('github', 'ncloud-sourcecommit', 'git', 'local');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('commit', 'pull_request', 'issue', 'review', 'check', 'user_note');--> statement-breakpoint
CREATE TABLE "owners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"provider" "repository_provider" NOT NULL,
	"instance" text NOT NULL,
	"external_id" text NOT NULL,
	"label" text NOT NULL,
	"location" text NOT NULL,
	"credential_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repositories_id_owner_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "repositories_identity_unique" UNIQUE("owner_id","provider","instance","external_id")
);
--> statement-breakpoint
CREATE TABLE "source_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"kind" "source_kind" NOT NULL,
	"external_id" text NOT NULL,
	"version" text NOT NULL,
	"url" text,
	"occurred_at" timestamp with time zone,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "source_records_version_unique" UNIQUE("owner_id","repository_id","kind","external_id","version")
);
--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_repository_owner_fk" FOREIGN KEY ("repository_id","owner_id") REFERENCES "public"."repositories"("id","owner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_records_period_idx" ON "source_records" USING btree ("owner_id","repository_id","occurred_at");