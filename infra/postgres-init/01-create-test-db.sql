-- Provision the dedicated test database alongside the development database.
-- Runs once, only on first initialization of the postgres data volume
-- (docker-entrypoint-initdb.d). Keeps `pnpm db:reset:test` working from a clean
-- clone without manual database creation.
CREATE DATABASE orgistry_test;
