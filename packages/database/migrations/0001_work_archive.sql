CREATE TABLE "work_analysis_versions" (
	"work_item_id" uuid NOT NULL,
	"snapshot_version" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "work_analysis_versions_work_item_id_snapshot_version_pk" PRIMARY KEY("work_item_id","snapshot_version")
);
--> statement-breakpoint
CREATE TABLE "work_item_sources" (
	"work_item_id" uuid NOT NULL,
	"source_record_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	CONSTRAINT "work_item_sources_work_item_id_source_record_id_pk" PRIMARY KEY("work_item_id","source_record_id")
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	CONSTRAINT "work_items_identity_unique" UNIQUE("owner_id","repository_id","external_id"),
	CONSTRAINT "work_items_scope_unique" UNIQUE("id","owner_id","repository_id")
);
--> statement-breakpoint
CREATE TABLE "work_review_versions" (
	"work_item_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"version" text NOT NULL,
	"previous_version" text,
	"snapshot_version" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "work_review_versions_work_item_id_revision_pk" PRIMARY KEY("work_item_id","revision"),
	CONSTRAINT "work_review_versions_identity_unique" UNIQUE("work_item_id","version"),
	CONSTRAINT "work_review_versions_previous_check" CHECK (("work_review_versions"."revision" = 1 AND "work_review_versions"."previous_version" IS NULL)
    OR ("work_review_versions"."revision" > 1 AND "work_review_versions"."previous_version" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "owners" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_scope_unique" UNIQUE("id","owner_id","repository_id");--> statement-breakpoint
ALTER TABLE "work_analysis_versions" ADD CONSTRAINT "work_analysis_versions_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item_sources" ADD CONSTRAINT "work_item_sources_work_scope_fk" FOREIGN KEY ("work_item_id","owner_id","repository_id") REFERENCES "public"."work_items"("id","owner_id","repository_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item_sources" ADD CONSTRAINT "work_item_sources_source_scope_fk" FOREIGN KEY ("source_record_id","owner_id","repository_id") REFERENCES "public"."source_records"("id","owner_id","repository_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_repository_owner_fk" FOREIGN KEY ("repository_id","owner_id") REFERENCES "public"."repositories"("id","owner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_review_versions" ADD CONSTRAINT "work_review_versions_analysis_fk" FOREIGN KEY ("work_item_id","snapshot_version") REFERENCES "public"."work_analysis_versions"("work_item_id","snapshot_version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_review_versions" ADD CONSTRAINT "work_review_versions_previous_fk" FOREIGN KEY ("work_item_id","previous_version") REFERENCES "public"."work_review_versions"("work_item_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owners" ADD CONSTRAINT "owners_external_id_unique" UNIQUE("external_id");
