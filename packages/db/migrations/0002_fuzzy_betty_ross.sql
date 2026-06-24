CREATE TABLE "memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"role_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"invited_by_user_id" text,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"is_system" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_removed_by_user_id_users_id_fk" FOREIGN KEY ("removed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_memberships_active_user_org" ON "memberships" USING btree ("user_id","organization_id") WHERE "memberships"."status" = 'active';--> statement-breakpoint
CREATE INDEX "ix_memberships_user_id" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_memberships_organization_id" ON "memberships" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ix_memberships_role_id" ON "memberships" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_organizations_slug" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "ix_organizations_created_by" ON "organizations" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "ix_organizations_status" ON "organizations" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_roles_key" ON "roles" USING btree ("key");--> statement-breakpoint
-- Baseline v1 role seed (Sprint 4). Idempotent: re-applying the migration (or
-- running it after a partial seed) is a no-op via ON CONFLICT. These rows are
-- referenced by stable IDs from `@orgistry/db` (ROLE_IDS) when assigning
-- memberships, so the IDs here are part of the migration contract.
INSERT INTO "roles" ("id", "key", "name", "description", "is_system") VALUES
	('role_owner', 'owner', 'Owner', 'Full control of the organization.', true),
	('role_admin', 'admin', 'Admin', 'Administrative access to the organization.', true),
	('role_member', 'member', 'Member', 'Standard member access to the organization.', true),
	('role_viewer', 'viewer', 'Viewer', 'Read-only access to the organization.', true)
ON CONFLICT ("key") DO NOTHING;