CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" integer GENERATED ALWAYS AS IDENTITY (sequence name "agent_event_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"tenant_id" uuid,
	"run_id" uuid,
	"agent" text,
	"type" text NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"subject_type" text,
	"subject_id" uuid,
	"job_id" uuid,
	"message" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"agent" text NOT NULL,
	"task" text NOT NULL,
	"subject_type" text,
	"subject_id" uuid,
	"job_id" uuid,
	"step_id" uuid,
	"parent_run_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"provider" text,
	"model" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 4) DEFAULT 0 NOT NULL,
	"summary" text,
	"error" text,
	"idempotency_key" text,
	"dependencies" text[] DEFAULT '{}'::text[] NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"proposal_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"submission_mode" text DEFAULT 'manual' NOT NULL,
	"idempotency_key" text NOT NULL,
	"external_ref" text,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"price_usd" numeric(14, 4),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid,
	"step_id" uuid,
	"kind" text NOT NULL,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"storage_key" text NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"width" integer,
	"height" integer,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid,
	"from_state" text,
	"to_state" text,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"source_key" text,
	"external_id" text,
	"country" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_estimate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"opportunity_id" uuid,
	"job_id" uuid,
	"analysis_id" uuid,
	"breakdown" jsonb NOT NULL,
	"total_cost_usd" numeric(14, 4) NOT NULL,
	"gross_profit_usd" numeric(14, 4) NOT NULL,
	"gross_margin" double precision NOT NULL,
	"complete" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_ledger_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid,
	"opportunity_id" uuid,
	"category" text NOT NULL,
	"kind" text NOT NULL,
	"provider" text,
	"model" text,
	"amount_usd" numeric(14, 4) NOT NULL,
	"paid" boolean DEFAULT false NOT NULL,
	"agent_run_id" uuid,
	"generation_id" uuid,
	"memo" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"status" text DEFAULT 'preparing' NOT NULL,
	"package_asset_id" uuid,
	"manifest" jsonb,
	"client_message" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid,
	"step_id" uuid,
	"agent_run_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"capability" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"estimated_cost_usd" numeric(14, 4) DEFAULT 0 NOT NULL,
	"actual_cost_usd" numeric(14, 4),
	"cost_source" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"latency_ms" integer,
	"external_task_id" text,
	"asset_id" uuid,
	"qa_passed" boolean,
	"repair_of_id" uuid,
	"route_rationale" text,
	"error" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_key" (
	"key" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid,
	"scope" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"opportunity_id" uuid,
	"application_id" uuid,
	"client_id" uuid,
	"title" text NOT NULL,
	"service_family" text NOT NULL,
	"status" text DEFAULT 'intake' NOT NULL,
	"price_usd" numeric(14, 4) NOT NULL,
	"spend_limit_usd" numeric(14, 4) NOT NULL,
	"estimated_cost_usd" numeric(14, 4) DEFAULT 0 NOT NULL,
	"actual_cost_usd" numeric(14, 4) DEFAULT 0 NOT NULL,
	"repair_count" integer DEFAULT 0 NOT NULL,
	"acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"brief" text DEFAULT '' NOT NULL,
	"due_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"allocation_pct" double precision DEFAULT 0 NOT NULL,
	"recommended_allocation_pct" double precision,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"metrics" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_insight" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"headline" text NOT NULL,
	"summary" text NOT NULL,
	"body" jsonb NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"agent_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"link" text,
	"dedupe_key" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"client_name" text,
	"client_country" text,
	"client_rating" double precision,
	"client_spend_usd" numeric(14, 4),
	"budget_type" text DEFAULT 'unknown' NOT NULL,
	"budget_min_usd" numeric(14, 4),
	"budget_max_usd" numeric(14, 4),
	"currency" text DEFAULT 'USD' NOT NULL,
	"skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"market_key" text,
	"proposals_count" integer,
	"posted_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"status" text DEFAULT 'new' NOT NULL,
	"dedupe_hash" text NOT NULL,
	"duplicate_of_id" uuid,
	"raw" jsonb,
	"expected_profit_usd" numeric(14, 4),
	"expected_margin" double precision,
	"estimated_cost_usd" numeric(14, 4),
	"expected_fees_usd" numeric(14, 4),
	"price_usd" numeric(14, 4),
	"overall_score" double precision,
	"recommendation" text,
	"estimate_complete" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_analysis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"analysis" jsonb NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"agent_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_score" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"analysis_id" uuid,
	"cost_estimate_id" uuid,
	"fit" double precision NOT NULL,
	"complexity" double precision NOT NULL,
	"revision_risk" double precision NOT NULL,
	"deadline_risk" double precision NOT NULL,
	"confidence" double precision NOT NULL,
	"overall" double precision NOT NULL,
	"recommendation" text NOT NULL,
	"gates" jsonb NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"headline" text NOT NULL,
	"cover_letter" text NOT NULL,
	"scope" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"price_usd" numeric(14, 4) NOT NULL,
	"timeline_days" integer NOT NULL,
	"assumptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"agent_run_id" uuid,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_integration" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider_key" text NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'needs_configuration' NOT NULL,
	"status_detail" text,
	"latency_ms" integer,
	"meta" jsonb,
	"last_check_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_metric" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"capability" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"successes" integer DEFAULT 0 NOT NULL,
	"qa_passes" integer DEFAULT 0 NOT NULL,
	"repairs" integer DEFAULT 0 NOT NULL,
	"total_cost_usd" numeric(14, 4) DEFAULT 0 NOT NULL,
	"avg_latency_ms" integer DEFAULT 0 NOT NULL,
	"usable_rate" double precision,
	"cost_per_usable_usd" numeric(14, 4),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_secret" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider_key" text NOT NULL,
	"name" text NOT NULL,
	"ciphertext" text NOT NULL,
	"hint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qa_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"step_id" uuid,
	"generation_id" uuid,
	"reviewer" text NOT NULL,
	"provider" text,
	"model" text,
	"verdict" text NOT NULL,
	"score" double precision NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" numeric NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "repair" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"qa_review_id" uuid,
	"step_id" uuid,
	"strategy" text NOT NULL,
	"rationale" text NOT NULL,
	"incremental_cost_usd" numeric(14, 4) DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"request" text NOT NULL,
	"interpretation" text,
	"in_scope" boolean,
	"change_order_usd" numeric(14, 4),
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "source_integration" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'needs_configuration' NOT NULL,
	"status_detail" text,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"mode" text DEFAULT 'demo' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"planned_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_step" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"agent" text NOT NULL,
	"capability" text,
	"depends_on" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"provider" text,
	"model" text,
	"estimated_cost_usd" numeric(14, 4) DEFAULT 0 NOT NULL,
	"actual_cost_usd" numeric(14, 4) DEFAULT 0 NOT NULL,
	"acceptance" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb,
	"error" text,
	"position" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_event" ADD CONSTRAINT "agent_event_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_opportunity_id_opportunity_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_proposal_id_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposal"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client" ADD CONSTRAINT "client_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_estimate" ADD CONSTRAINT "cost_estimate_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_estimate" ADD CONSTRAINT "cost_estimate_opportunity_id_opportunity_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_estimate" ADD CONSTRAINT "cost_estimate_analysis_id_opportunity_analysis_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."opportunity_analysis"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_ledger_entry" ADD CONSTRAINT "cost_ledger_entry_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery" ADD CONSTRAINT "delivery_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery" ADD CONSTRAINT "delivery_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation" ADD CONSTRAINT "generation_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation" ADD CONSTRAINT "generation_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_opportunity_id_opportunity_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunity"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market" ADD CONSTRAINT "market_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_insight" ADD CONSTRAINT "market_insight_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_analysis" ADD CONSTRAINT "opportunity_analysis_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_analysis" ADD CONSTRAINT "opportunity_analysis_opportunity_id_opportunity_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_score" ADD CONSTRAINT "opportunity_score_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_score" ADD CONSTRAINT "opportunity_score_opportunity_id_opportunity_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_score" ADD CONSTRAINT "opportunity_score_analysis_id_opportunity_analysis_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."opportunity_analysis"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_score" ADD CONSTRAINT "opportunity_score_cost_estimate_id_cost_estimate_id_fk" FOREIGN KEY ("cost_estimate_id") REFERENCES "public"."cost_estimate"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_opportunity_id_opportunity_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_integration" ADD CONSTRAINT "provider_integration_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_metric" ADD CONSTRAINT "provider_metric_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_secret" ADD CONSTRAINT "provider_secret_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_review" ADD CONSTRAINT "qa_review_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_review" ADD CONSTRAINT "qa_review_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repair" ADD CONSTRAINT "repair_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repair" ADD CONSTRAINT "repair_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision" ADD CONSTRAINT "revision_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision" ADD CONSTRAINT "revision_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_integration" ADD CONSTRAINT "source_integration_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow" ADD CONSTRAINT "workflow_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow" ADD CONSTRAINT "workflow_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_step" ADD CONSTRAINT "workflow_step_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_step" ADD CONSTRAINT "workflow_step_workflow_id_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_step" ADD CONSTRAINT "workflow_step_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_event_tenant_seq_idx" ON "agent_event" USING btree ("tenant_id","seq");--> statement-breakpoint
CREATE INDEX "agent_event_subject_idx" ON "agent_event" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "agent_event_job_idx" ON "agent_event" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "agent_run_tenant_created_idx" ON "agent_run" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_run_job_idx" ON "agent_run" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "agent_run_status_idx" ON "agent_run" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "application_idem_uq" ON "application" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "application_tenant_status_idx" ON "application" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "asset_job_idx" ON "asset" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "audit_tenant_created_idx" ON "audit_event" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_subject_idx" ON "audit_event" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "client_tenant_idx" ON "client" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "cost_estimate_opp_idx" ON "cost_estimate" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "cost_estimate_job_idx" ON "cost_estimate" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "ledger_tenant_created_idx" ON "cost_ledger_entry" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "ledger_job_idx" ON "cost_ledger_entry" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "ledger_opp_idx" ON "cost_ledger_entry" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "delivery_job_idx" ON "delivery" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "generation_idem_uq" ON "generation" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "generation_job_idx" ON "generation" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "generation_provider_idx" ON "generation" USING btree ("provider","model");--> statement-breakpoint
CREATE UNIQUE INDEX "job_application_uq" ON "job" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "job_tenant_status_idx" ON "job" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "market_tenant_key_uq" ON "market" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE INDEX "market_insight_tenant_idx" ON "market_insight" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_tenant_user_uq" ON "membership" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "membership_user_idx" ON "membership" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notification_tenant_idx" ON "notification" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_dedupe_uq" ON "notification" USING btree ("tenant_id","dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_source_uq" ON "opportunity" USING btree ("tenant_id","source_key","external_id");--> statement-breakpoint
CREATE INDEX "opportunity_tenant_status_idx" ON "opportunity" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "opportunity_tenant_created_idx" ON "opportunity" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "opportunity_dedupe_idx" ON "opportunity" USING btree ("tenant_id","dedupe_hash");--> statement-breakpoint
CREATE INDEX "opportunity_analysis_opp_idx" ON "opportunity_analysis" USING btree ("opportunity_id","version");--> statement-breakpoint
CREATE INDEX "opportunity_score_opp_idx" ON "opportunity_score" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "proposal_opp_idx" ON "proposal" USING btree ("opportunity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_integration_tenant_key_uq" ON "provider_integration" USING btree ("tenant_id","provider_key");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_metric_uq" ON "provider_metric" USING btree ("tenant_id","provider","model","capability");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_secret_uq" ON "provider_secret" USING btree ("tenant_id","provider_key","name");--> statement-breakpoint
CREATE INDEX "qa_review_job_idx" ON "qa_review" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "repair_job_idx" ON "repair" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "revision_job_idx" ON "revision" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_integration_tenant_key_uq" ON "source_integration" USING btree ("tenant_id","source_key");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "workflow_job_idx" ON "workflow" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_step_key_uq" ON "workflow_step" USING btree ("workflow_id","key");--> statement-breakpoint
CREATE INDEX "workflow_step_job_idx" ON "workflow_step" USING btree ("job_id");