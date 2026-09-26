-- Least-privilege runtime role for web/app/worker (security review L4).
-- Idempotent. Run as the owner role `gigpilot` with psql variable :app_password.
-- Migrations keep running as `gigpilot`; the apps connect as `gigpilot_app`.
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gigpilot_app') THEN
    CREATE ROLE gigpilot_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END $$;
ALTER ROLE gigpilot_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'app_password';
GRANT CONNECT ON DATABASE gigpilot TO gigpilot_app;
-- Guardrails against runaway queries / abandoned transactions holding locks.
ALTER ROLE gigpilot_app SET statement_timeout = '120s';
ALTER ROLE gigpilot_app SET lock_timeout = '30s';
ALTER ROLE gigpilot_app SET idle_in_transaction_session_timeout = '5min';

-- Application tables: data access only (no DDL).
GRANT USAGE ON SCHEMA public TO gigpilot_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gigpilot_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO gigpilot_app;
ALTER DEFAULT PRIVILEGES FOR ROLE gigpilot IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gigpilot_app;
ALTER DEFAULT PRIVILEGES FOR ROLE gigpilot IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO gigpilot_app;

-- Drizzle migration journal: read-only (worker readiness compares migration state).
CREATE SCHEMA IF NOT EXISTS drizzle;
GRANT USAGE ON SCHEMA drizzle TO gigpilot_app;
GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO gigpilot_app;
ALTER DEFAULT PRIVILEGES FOR ROLE gigpilot IN SCHEMA drizzle GRANT SELECT ON TABLES TO gigpilot_app;

-- pg-boss manages its own schema (it creates queue partitions at runtime), so
-- the runtime role owns that schema and everything in it — and nothing else.
CREATE SCHEMA IF NOT EXISTS pgboss;
ALTER SCHEMA pgboss OWNER TO gigpilot_app;
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS obj, c.relkind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'pgboss' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
      -- identity/serial sequences follow their owning table
      AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i')))
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO gigpilot_app',
      CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END, r.obj);
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS obj FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'pgboss' LOOP
    EXECUTE format('ALTER ROUTINE %s OWNER TO gigpilot_app', r.obj);
  END LOOP;
  FOR r IN SELECT t.oid::regtype AS obj FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname = 'pgboss' AND t.typtype IN ('e', 'd') LOOP
    EXECUTE format('ALTER TYPE %s OWNER TO gigpilot_app', r.obj);
  END LOOP;
END $$;
