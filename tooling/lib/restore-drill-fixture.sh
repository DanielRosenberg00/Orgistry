#!/usr/bin/env bash
#
# Deterministic fixture identity for the restore drill (Sprint 25, ORG-PR-005).
#
# SINGLE SOURCE OF TRUTH for the drill's synthetic Orgistry data. The seed SQL
# (tooling/fixtures/restore-drill-seed.sql) receives these as psql variables and
# the drill script uses them to make an authenticated API call against the
# restored database.
#
# EVERY VALUE HERE IS FAKE, PUBLIC, AND LOCAL-ONLY. The drill creates its own
# throwaway PostgreSQL containers, seeds them with these rows, and destroys
# them. Nothing here authenticates against anything an operator runs.

# API key, in the product's `orgistry_<displayId>_<secret>` format. Only the
# SHA-256 of the secret component is ever stored (schema/api-keys.ts), and the
# drill DERIVES that hash at run time (`sha256_hex` in pg-tools.sh) rather than
# carrying a hash literal: a committed 64-hex constant is indistinguishable
# from a real credential to a secret scanner, and a derived value cannot drift
# from the secret it belongs to. `restore-drill-fixture.test.ts` pins the one
# assumption this makes — that the product hashes an API-key secret as plain
# SHA-256 hex, which is what the shell computes.
DRILL_API_KEY_DISPLAY_PREFIX='orgistry_RSTRDRLL'
DRILL_API_KEY_SECRET='restore-drill-fixture-secret-not-a-real-credential'
DRILL_API_KEY_RAW="${DRILL_API_KEY_DISPLAY_PREFIX}_${DRILL_API_KEY_SECRET}"

# Tenant and resource identities the restore assertions look for.
DRILL_ORG_ID='org_restore_drill'
DRILL_ORG_SLUG='restore-drill'
DRILL_OWNER_USER_ID='user_restore_drill_owner'
DRILL_MEMBER_USER_ID='user_restore_drill_member'
DRILL_PROJECT_NAMES=('Restore Drill Alpha' 'Restore Drill Beta')

# Expected row counts after a successful restore, per table. The drill compares
# the restored database against these exactly.
DRILL_EXPECTED_USERS=2
DRILL_EXPECTED_ORGANIZATIONS=1
DRILL_EXPECTED_MEMBERSHIPS=2
DRILL_EXPECTED_PROJECTS=2
DRILL_EXPECTED_API_KEYS=1
DRILL_EXPECTED_INVITATIONS=1
DRILL_EXPECTED_SECURITY_EVENTS=3
