CREATE TABLE "spend_reservation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid,
	"step_id" uuid,
	"key" text NOT NULL,
	"provider" text,
	"amount_usd" numeric(14, 4) NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"actual_usd" numeric(14, 4),
	"memo" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX IF EXISTS "opportunity_analysis_opp_idx";--> statement-breakpoint
ALTER TABLE "delivery" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "generation" ADD COLUMN "unit_key" text;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "extra_repairs" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "spend_reservation" ADD CONSTRAINT "spend_reservation_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "spend_reservation_key_uq" ON "spend_reservation" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE INDEX "spend_reservation_open_idx" ON "spend_reservation" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "generation_unit_idx" ON "generation" USING btree ("tenant_id","unit_key");--> statement-breakpoint
-- Existing data may contain duplicate (opportunity_id, version) pairs from concurrent
-- analyses. Renumber ONLY the affected opportunities (chronological order preserved)
-- so the unique index can be built without losing any analysis row.
WITH affected AS (
	SELECT DISTINCT "opportunity_id" FROM "opportunity_analysis"
	GROUP BY "opportunity_id", "version" HAVING count(*) > 1
), ranked AS (
	SELECT oa."id", row_number() OVER (PARTITION BY oa."opportunity_id" ORDER BY oa."version", oa."created_at", oa."id") AS rn
	FROM "opportunity_analysis" oa JOIN affected a ON a."opportunity_id" = oa."opportunity_id"
)
UPDATE "opportunity_analysis" SET "version" = ranked.rn FROM ranked WHERE "opportunity_analysis"."id" = ranked."id";--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_analysis_opp_version_uq" ON "opportunity_analysis" USING btree ("opportunity_id","version");