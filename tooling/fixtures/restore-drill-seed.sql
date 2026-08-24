-- Deterministic synthetic Orgistry data for the restore drill
-- (Sprint 25, ORG-PR-005).
--
-- Seeds one row per entity class the recovery contract must preserve:
-- user, organization, membership, role assignment, plan/entitlement state,
-- project, API-key hash metadata, invitation, and security/audit events.
-- Roles, permissions, and plans already exist — they are seeded by the
-- migration baseline (migrations 0002, 0003, 0005), so this file references
-- them rather than recreating them.
--
-- Every identifier and hash below is a FIXED, FAKE, LOCAL-ONLY value. The
-- password hashes are not real Argon2id output and authenticate nothing; the
-- API-key and invitation hashes correspond to fixture secrets published in
-- tooling/lib/restore-drill-fixture.sh. This file is only ever applied to a
-- throwaway container the drill creates and destroys.
--
-- Values arrive as psql variables from the drill so the fixture identity has
-- exactly one definition (tooling/lib/restore-drill-fixture.sh).

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO users (id, email, normalized_email, password_hash, display_name, email_verified_at)
VALUES
  (:'owner_user_id', 'owner@restore-drill.invalid', 'owner@restore-drill.invalid',
   'fixture-not-a-real-password-hash-owner', 'Restore Drill Owner', now()),
  (:'member_user_id', 'member@restore-drill.invalid', 'member@restore-drill.invalid',
   'fixture-not-a-real-password-hash-member', 'Restore Drill Member', NULL);

INSERT INTO organizations (id, name, slug, type, status, created_by_user_id)
VALUES (:'org_id', 'Restore Drill Org', :'org_slug', 'team', 'active', :'owner_user_id');

INSERT INTO memberships (id, user_id, organization_id, role_id, status)
VALUES
  ('mem_restore_drill_owner', :'owner_user_id', :'org_id', 'role_owner', 'active'),
  ('mem_restore_drill_member', :'member_user_id', :'org_id', 'role_member', 'active');

-- Plan/entitlement state. `pro` grants API-key access, which the artifact
-- stage of the drill depends on.
INSERT INTO organization_plans (id, organization_id, plan_key, changed_by_user_id)
VALUES ('oplan_restore_drill', :'org_id', 'pro', :'owner_user_id');

INSERT INTO projects (id, organization_id, name, created_by_user_id)
VALUES
  ('proj_restore_drill_alpha', :'org_id', :'project_alpha', :'owner_user_id'),
  ('proj_restore_drill_beta', :'org_id', :'project_beta', :'owner_user_id');

-- API-key HASH metadata. The raw secret is never stored by the product and is
-- not stored here either; only its SHA-256 is.
INSERT INTO api_keys (id, organization_id, name, display_prefix, secret_hash, scopes, created_by_user_id)
VALUES (
  'key_restore_drill',
  :'org_id',
  'Restore drill key',
  :'api_key_display_prefix',
  :'api_key_secret_hash',
  '["projects:read"]'::jsonb,
  :'owner_user_id'
);

INSERT INTO invitations (
  id, organization_id, invited_email, invited_email_normalized, role_id,
  token_hash, status, invited_by_user_id, expires_at
)
VALUES (
  'inv_restore_drill',
  :'org_id',
  'invitee@restore-drill.invalid',
  'invitee@restore-drill.invalid',
  'role_member',
  'fixture-not-a-real-invitation-token-hash',
  'pending',
  :'owner_user_id',
  now() + interval '7 days'
);

-- Audit / security history, including one organization-scoped event so the
-- Sprint 20 audit read path has something to resolve after a restore.
INSERT INTO security_events (id, user_id, organization_id, actor_type, event_type, metadata, created_at)
VALUES
  ('sevt_restore_drill_1', :'owner_user_id', NULL, 'user', 'auth.login_succeeded', '{}'::jsonb, now() - interval '2 days'),
  ('sevt_restore_drill_2', :'owner_user_id', :'org_id', 'user', 'organization.created', '{}'::jsonb, now() - interval '2 days'),
  ('sevt_restore_drill_3', NULL, NULL, 'anonymous', 'auth.login_failed', '{}'::jsonb, now() - interval '1 days');

-- Infrastructure metadata marker: proves a non-domain table survives too.
INSERT INTO app_meta (key, value)
VALUES ('restore_drill_marker', 'sprint-25')
ON CONFLICT (key) DO UPDATE SET value = excluded.value;

COMMIT;
