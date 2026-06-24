CREATE TABLE "permissions" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" text NOT NULL,
	"permission_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_permissions_key" ON "permissions" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_role_permissions_role_permission" ON "role_permissions" USING btree ("role_id","permission_id");
--> statement-breakpoint
-- Fixed v1 permission catalog seed (Sprint 5). Idempotent via ON CONFLICT so
-- re-applying the migration (or running it after a partial seed) is a no-op.
-- These rows are DERIVED from the canonical catalog in @orgistry/contracts
-- (PERMISSION_CATALOG) with stable ids (permissionRowId), so the database, the
-- typed requirePermission helper, and the read-only RBAC endpoints cannot drift.
INSERT INTO "permissions" ("id", "key", "name", "description") VALUES
	('perm_org_read', 'org.read', 'Read organization', 'View organization details.'),
	('perm_org_update', 'org.update', 'Update organization', 'Edit organization settings.'),
	('perm_members_read', 'members.read', 'Read members', 'List the organization''s members.'),
	('perm_members_invite', 'members.invite', 'Invite members', 'Invite people to the organization.'),
	('perm_members_change_role', 'members.change_role', 'Change member roles', 'Change the role of a member.'),
	('perm_members_remove', 'members.remove', 'Remove members', 'Remove a member from the organization.'),
	('perm_invitations_read', 'invitations.read', 'Read invitations', 'View pending invitations.'),
	('perm_invitations_create', 'invitations.create', 'Create invitations', 'Create new invitations.'),
	('perm_invitations_revoke', 'invitations.revoke', 'Revoke invitations', 'Revoke pending invitations.'),
	('perm_roles_read', 'roles.read', 'Read roles', 'View the role catalog.'),
	('perm_permissions_read', 'permissions.read', 'Read permissions', 'View the permission catalog and matrix.'),
	('perm_projects_read', 'projects.read', 'Read projects', 'View projects.'),
	('perm_projects_create', 'projects.create', 'Create projects', 'Create new projects.'),
	('perm_projects_update', 'projects.update', 'Update projects', 'Edit existing projects.'),
	('perm_projects_delete', 'projects.delete', 'Delete projects', 'Delete projects.'),
	('perm_api_keys_read', 'api_keys.read', 'Read API keys', 'View API keys.'),
	('perm_api_keys_create', 'api_keys.create', 'Create API keys', 'Create new API keys.'),
	('perm_api_keys_revoke', 'api_keys.revoke', 'Revoke API keys', 'Revoke API keys.'),
	('perm_audit_events_read', 'audit_events.read', 'Read audit events', 'View organization audit events.'),
	('perm_plan_read', 'plan.read', 'Read plan', 'View the organization''s plan.'),
	('perm_plan_change_demo', 'plan.change_demo', 'Change plan (demo)', 'Change the organization''s demo plan.'),
	('perm_sessions_read', 'sessions.read', 'Read sessions', 'View organization sessions.'),
	('perm_sessions_revoke', 'sessions.revoke', 'Revoke sessions', 'Revoke organization sessions.')
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
-- Fixed v1 role -> permission mapping seed (Sprint 5). Idempotent via the
-- composite primary key. Derived from ROLE_PERMISSIONS in @orgistry/contracts.
INSERT INTO "role_permissions" ("role_id", "permission_id") VALUES
	('role_owner', 'perm_org_read'),
	('role_owner', 'perm_org_update'),
	('role_owner', 'perm_members_read'),
	('role_owner', 'perm_members_invite'),
	('role_owner', 'perm_members_change_role'),
	('role_owner', 'perm_members_remove'),
	('role_owner', 'perm_invitations_read'),
	('role_owner', 'perm_invitations_create'),
	('role_owner', 'perm_invitations_revoke'),
	('role_owner', 'perm_roles_read'),
	('role_owner', 'perm_permissions_read'),
	('role_owner', 'perm_projects_read'),
	('role_owner', 'perm_projects_create'),
	('role_owner', 'perm_projects_update'),
	('role_owner', 'perm_projects_delete'),
	('role_owner', 'perm_api_keys_read'),
	('role_owner', 'perm_api_keys_create'),
	('role_owner', 'perm_api_keys_revoke'),
	('role_owner', 'perm_audit_events_read'),
	('role_owner', 'perm_plan_read'),
	('role_owner', 'perm_plan_change_demo'),
	('role_owner', 'perm_sessions_read'),
	('role_owner', 'perm_sessions_revoke'),
	('role_admin', 'perm_org_read'),
	('role_admin', 'perm_org_update'),
	('role_admin', 'perm_members_read'),
	('role_admin', 'perm_members_invite'),
	('role_admin', 'perm_members_change_role'),
	('role_admin', 'perm_members_remove'),
	('role_admin', 'perm_invitations_read'),
	('role_admin', 'perm_invitations_create'),
	('role_admin', 'perm_invitations_revoke'),
	('role_admin', 'perm_roles_read'),
	('role_admin', 'perm_permissions_read'),
	('role_admin', 'perm_projects_read'),
	('role_admin', 'perm_projects_create'),
	('role_admin', 'perm_projects_update'),
	('role_admin', 'perm_projects_delete'),
	('role_admin', 'perm_api_keys_read'),
	('role_admin', 'perm_api_keys_create'),
	('role_admin', 'perm_api_keys_revoke'),
	('role_admin', 'perm_audit_events_read'),
	('role_admin', 'perm_plan_read'),
	('role_admin', 'perm_sessions_read'),
	('role_admin', 'perm_sessions_revoke'),
	('role_member', 'perm_org_read'),
	('role_member', 'perm_members_read'),
	('role_member', 'perm_roles_read'),
	('role_member', 'perm_permissions_read'),
	('role_member', 'perm_projects_read'),
	('role_member', 'perm_projects_create'),
	('role_member', 'perm_projects_update'),
	('role_member', 'perm_plan_read'),
	('role_viewer', 'perm_org_read'),
	('role_viewer', 'perm_projects_read'),
	('role_viewer', 'perm_plan_read')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
