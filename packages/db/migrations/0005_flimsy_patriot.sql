CREATE TABLE "organization_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"plan_key" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"max_members" integer NOT NULL,
	"max_projects" integer NOT NULL,
	"api_keys_access" boolean NOT NULL,
	"max_api_keys" integer NOT NULL,
	"audit_log_access" boolean NOT NULL,
	"audit_retention_days" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_plans" ADD CONSTRAINT "organization_plans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_plans" ADD CONSTRAINT "organization_plans_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_organization_plans_organization" ON "organization_plans" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_plans_key" ON "plans" USING btree ("key");--> statement-breakpoint
-- Fixed v1 internal demo plan catalog seed (Sprint 7). Idempotent via ON
-- CONFLICT so re-applying the migration (or running it after a partial seed) is
-- a no-op. These rows are DERIVED from the canonical catalog in
-- @orgistry/contracts (PLAN_CATALOG) with stable ids (planRowId), so the
-- database, the typed entitlement resolver, and the plan/entitlements endpoints
-- cannot drift. These are internal demo plans only — there is NO billing,
-- subscription, or payment concept here.
INSERT INTO "plans" ("id", "key", "name", "description", "max_members", "max_projects", "api_keys_access", "max_api_keys", "audit_log_access", "audit_retention_days") VALUES
	('plan_free', 'free', 'Free', 'Starter demo plan with the smallest quotas and no premium features.', 3, 3, false, 0, false, 0),
	('plan_pro', 'pro', 'Pro', 'Growth demo plan with larger quotas, API keys, and audit access.', 10, 20, true, 5, true, 30),
	('plan_business', 'business', 'Business', 'Scale demo plan with the largest quotas and longest audit retention.', 50, 100, true, 25, true, 90)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
-- Backfill organization plan state (Sprint 7). Every existing organization is
-- deterministically assigned the default Free plan if it has no plan-state row
-- yet. The NOT EXISTS guard makes this idempotent, and the derived id keeps it
-- deterministic across environments. On a fresh database (no organizations) this
-- is a no-op; new organizations get their plan state from the provisioning code.
INSERT INTO "organization_plans" ("id", "organization_id", "plan_key", "changed_by_user_id")
SELECT 'oplan_' || o.id, o.id, 'free', o.created_by_user_id
FROM "organizations" o
WHERE NOT EXISTS (
	SELECT 1 FROM "organization_plans" op WHERE op.organization_id = o.id
);
