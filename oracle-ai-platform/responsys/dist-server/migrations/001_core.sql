-- 001_core: identity, tenancy, storage, imports, datasets, facts, reports, jobs, events, audit.
--
-- Applied by the migration (owner) role. The application connects as `rci_app`, which must
-- exist, must not own these tables, and must not have BYPASSRLS (checked at API startup).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rci_app') THEN
    RAISE EXCEPTION 'database role rci_app must exist before migrating (see docs/RESPONSYS_SETUP.md / scripts/setup-local.ts)';
  END IF;
END $$;

-- Tenant context helpers. NULLIF guards against the empty string a pooled connection holds
-- after a transaction-local setting is reset; a missing context yields NULL, which matches no row.
CREATE FUNCTION rci_ws() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid $$;
CREATE FUNCTION rci_uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

-- ---------------------------------------------------------------- identity (not tenant-scoped)
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  oidc_issuer text,
  oidc_subject text,
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  CONSTRAINT users_email_lower CHECK (email = lower(email)),
  CONSTRAINT users_oidc_pair CHECK ((oidc_issuer IS NULL) = (oidc_subject IS NULL))
);
CREATE UNIQUE INDEX users_email_uq ON users (email);
CREATE UNIQUE INDEX users_oidc_uq ON users (oidc_issuer, oidc_subject) WHERE oidc_issuer IS NOT NULL;

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  current_workspace_id uuid,
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  auth_method text NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE oidc_login_states (
  state text PRIMARY KEY,
  code_verifier text NOT NULL,
  nonce text NOT NULL,
  return_to text NOT NULL DEFAULT '/',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

-- ---------------------------------------------------------------- tenancy
CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('viewer', 'analyst', 'marketer', 'approver', 'owner')),
  -- Explicit grants for "by grant" permissions (e.g. action.execute). Never implied by role.
  grants text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

CREATE TABLE accounts (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  external_account_id text,
  timezone text NOT NULL,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  locale text NOT NULL DEFAULT 'en-US',
  brand jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_pack text NOT NULL DEFAULT 'starter',
  data_revision bigint NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, name)
);

-- ---------------------------------------------------------------- raw objects & imports
CREATE TABLE raw_objects (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  storage_key text NOT NULL UNIQUE,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  content_type text NOT NULL,
  original_filename text NOT NULL,
  scan_status text NOT NULL CHECK (scan_status IN ('text_checked', 'rejected')),
  retention_state text NOT NULL DEFAULT 'retained' CHECK (retention_state IN ('retained', 'deleted')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES accounts (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX raw_objects_hash_idx ON raw_objects (workspace_id, account_id, sha256);

CREATE TABLE datasets (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  source_type text NOT NULL CHECK (source_type IN ('upload_legacy_summary', 'upload_campaign_metrics', 'responsys_reporting')),
  grain text NOT NULL CHECK (grain IN ('account_window', 'campaign_launch', 'campaign_day')),
  time_basis text NOT NULL CHECK (time_basis IN ('declared_snapshot', 'send_cohort', 'event_time')),
  active_version_id uuid,
  archived_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES accounts (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE import_jobs (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  raw_object_id uuid NOT NULL,
  format text NOT NULL CHECK (format IN ('legacy_summary', 'campaign_metrics', 'unknown')),
  status text NOT NULL CHECK (status IN ('uploaded', 'needs_mapping', 'validating', 'ready_to_commit',
                                          'committing', 'completed', 'failed', 'cancelled')),
  detection jsonb NOT NULL DEFAULT '{}'::jsonb,
  mapping jsonb,
  mapping_version int NOT NULL DEFAULT 1,
  validation jsonb,
  target_dataset_id uuid,
  dataset_version_id uuid,
  duplicate_of uuid,
  error_message text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (id),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES accounts (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, raw_object_id) REFERENCES raw_objects (workspace_id, id),
  FOREIGN KEY (workspace_id, target_dataset_id) REFERENCES datasets (workspace_id, id)
);
CREATE INDEX import_jobs_account_idx ON import_jobs (workspace_id, account_id, created_at DESC);

CREATE TABLE dataset_versions (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL,
  account_id uuid NOT NULL,
  version int NOT NULL CHECK (version >= 1),
  status text NOT NULL CHECK (status IN ('staged', 'active', 'superseded', 'failed', 'deactivated')),
  import_job_id uuid,
  timezone text NOT NULL,
  currency char(3) NOT NULL,
  source_as_of timestamptz,
  coverage_start date,
  coverage_end_exclusive date,
  row_count int NOT NULL DEFAULT 0,
  quality jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_signature text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  superseded_at timestamptz,
  PRIMARY KEY (id),
  UNIQUE (workspace_id, id),
  UNIQUE (dataset_id, version),
  FOREIGN KEY (workspace_id, dataset_id) REFERENCES datasets (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, account_id) REFERENCES accounts (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, import_job_id) REFERENCES import_jobs (workspace_id, id),
  CHECK (coverage_start IS NULL OR coverage_end_exclusive IS NULL OR coverage_start < coverage_end_exclusive)
);
CREATE UNIQUE INDEX dataset_versions_one_active ON dataset_versions (dataset_id) WHERE status = 'active';
ALTER TABLE datasets ADD FOREIGN KEY (workspace_id, active_version_id) REFERENCES dataset_versions (workspace_id, id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE import_jobs ADD FOREIGN KEY (workspace_id, dataset_version_id) REFERENCES dataset_versions (workspace_id, id);

-- ---------------------------------------------------------------- observed facts
CREATE TABLE summary_window_facts (
  workspace_id uuid NOT NULL,
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL,
  dataset_version_id uuid NOT NULL,
  channel text NOT NULL,
  window_key text NOT NULL,
  window_label text NOT NULL,
  window_days int NOT NULL CHECK (window_days > 0),
  window_start date NOT NULL,
  window_end_exclusive date NOT NULL,
  currency char(3) NOT NULL,
  sent numeric(20, 0) CHECK (sent >= 0),
  delivered numeric(20, 0) CHECK (delivered >= 0),
  skipped numeric(20, 0) CHECK (skipped >= 0),
  bounce_rate numeric(12, 6) CHECK (bounce_rate >= 0),
  soft_bounce_rate numeric(12, 6) CHECK (soft_bounce_rate >= 0),
  hard_bounce_rate numeric(12, 6) CHECK (hard_bounce_rate >= 0),
  open_rate numeric(12, 6) CHECK (open_rate >= 0),
  click_rate numeric(12, 6) CHECK (click_rate >= 0),
  unsubscribe_rate numeric(12, 6) CHECK (unsubscribe_rate >= 0),
  revenue numeric(20, 4),
  conversions numeric(20, 0) CHECK (conversions >= 0),
  source_row int NOT NULL,
  FOREIGN KEY (workspace_id, dataset_version_id) REFERENCES dataset_versions (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, account_id) REFERENCES accounts (workspace_id, id) ON DELETE CASCADE,
  UNIQUE (dataset_version_id, channel, window_key)
);

CREATE TABLE campaigns (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  name text NOT NULL,
  channel text NOT NULL,
  program text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, account_id, external_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES accounts (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE campaign_launch_facts (
  workspace_id uuid NOT NULL,
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL,
  dataset_version_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  launch_external_id text,
  channel text NOT NULL,
  launch_date date NOT NULL,
  fact_date date,
  campaign_name text NOT NULL,
  program text,
  subject_line text,
  currency char(3) NOT NULL,
  sent numeric(20, 0) CHECK (sent >= 0),
  delivered numeric(20, 0) CHECK (delivered >= 0),
  skipped numeric(20, 0) CHECK (skipped >= 0),
  bounces numeric(20, 0) CHECK (bounces >= 0),
  total_opens numeric(20, 0) CHECK (total_opens >= 0),
  unique_opens numeric(20, 0) CHECK (unique_opens >= 0),
  total_clicks numeric(20, 0) CHECK (total_clicks >= 0),
  unique_clicks numeric(20, 0) CHECK (unique_clicks >= 0),
  conversion_events numeric(20, 0) CHECK (conversion_events >= 0),
  orders numeric(20, 0) CHECK (orders >= 0),
  revenue numeric(20, 4),
  unsubscribes numeric(20, 0) CHECK (unsubscribes >= 0),
  complaints numeric(20, 0) CHECK (complaints >= 0),
  source_row int NOT NULL,
  FOREIGN KEY (workspace_id, dataset_version_id) REFERENCES dataset_versions (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, campaign_id) REFERENCES campaigns (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, account_id) REFERENCES accounts (workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX campaign_launch_facts_grain_uq ON campaign_launch_facts
  (dataset_version_id, campaign_id, COALESCE(launch_external_id, ''), launch_date, COALESCE(fact_date, '0001-01-01'::date));
CREATE INDEX campaign_launch_facts_scope_idx ON campaign_launch_facts (workspace_id, dataset_version_id, launch_date);
CREATE INDEX campaign_launch_facts_campaign_idx ON campaign_launch_facts (workspace_id, campaign_id);

-- ---------------------------------------------------------------- report snapshots
CREATE TABLE report_snapshots (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('overview', 'campaign', 'comparison')),
  scope jsonb NOT NULL,
  scope_hash text NOT NULL,
  data_revision bigint NOT NULL,
  dataset_version_ids uuid[] NOT NULL,
  definition_version text NOT NULL,
  result jsonb NOT NULL,
  result_hash text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, account_id, kind, scope_hash, data_revision, definition_version),
  FOREIGN KEY (workspace_id, account_id) REFERENCES accounts (workspace_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- durable jobs, events, audit
CREATE TABLE jobs (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled')),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  lease_expires_at timestamptz,
  last_error text,
  dedupe_key text,
  result jsonb,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX jobs_dedupe_uq ON jobs (workspace_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');
CREATE INDEX jobs_claim_idx ON jobs (status, run_after);

CREATE TABLE events (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id uuid,
  type text NOT NULL,
  resource_id text,
  revision bigint,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_ws_idx ON events (workspace_id, id);

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id uuid,
  action text NOT NULL,
  target_type text,
  target_id text,
  request_id text,
  outcome text NOT NULL CHECK (outcome IN ('success', 'denied', 'failure')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_ws_idx ON audit_events (workspace_id, created_at DESC);

CREATE TABLE idempotency_keys (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope text NOT NULL,
  key text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  request_hash text NOT NULL,
  status_code int,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, scope, key)
);

-- Claim runnable jobs across tenants. The runtime role cannot read other tenants' jobs, so
-- claiming is a narrowly scoped SECURITY DEFINER function. Expired leases are reclaimed.
CREATE FUNCTION rci_claim_jobs(p_worker text, p_lease_seconds int, p_limit int, p_types text[])
RETURNS SETOF jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  UPDATE jobs j
     SET status = 'running', locked_by = p_worker,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         attempts = j.attempts + 1, updated_at = now()
   WHERE j.id IN (
     SELECT id FROM jobs
      WHERE ((status = 'queued' AND run_after <= now()) OR (status = 'running' AND lease_expires_at < now()))
        AND (p_types IS NULL OR type = ANY (p_types))
      ORDER BY run_after, id
      FOR UPDATE SKIP LOCKED
      LIMIT p_limit)
  RETURNING j.*;
END $$;
REVOKE ALL ON FUNCTION rci_claim_jobs(text, int, int, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rci_claim_jobs(text, int, int, text[]) TO rci_app;

-- ---------------------------------------------------------------- row-level security
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['accounts', 'raw_objects', 'datasets', 'import_jobs', 'dataset_versions',
                           'summary_window_facts', 'campaigns', 'campaign_launch_facts', 'report_snapshots',
                           'jobs', 'events', 'audit_events', 'idempotency_keys']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (workspace_id = rci_ws()) WITH CHECK (workspace_id = rci_ws())', t);
  END LOOP;
END $$;

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
CREATE POLICY ws_select ON workspaces FOR SELECT
  USING (id = rci_ws() OR EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id = workspaces.id AND m.user_id = rci_uid()));
CREATE POLICY ws_insert ON workspaces FOR INSERT WITH CHECK (id = rci_ws());
CREATE POLICY ws_update ON workspaces FOR UPDATE USING (id = rci_ws()) WITH CHECK (id = rci_ws());

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY mem_select ON memberships FOR SELECT USING (workspace_id = rci_ws() OR user_id = rci_uid());
CREATE POLICY mem_write ON memberships FOR INSERT WITH CHECK (workspace_id = rci_ws());
CREATE POLICY mem_update ON memberships FOR UPDATE USING (workspace_id = rci_ws()) WITH CHECK (workspace_id = rci_ws());
CREATE POLICY mem_delete ON memberships FOR DELETE USING (workspace_id = rci_ws());

-- ---------------------------------------------------------------- grants for the runtime role
GRANT USAGE ON SCHEMA public TO rci_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, sessions, oidc_login_states TO rci_app;
GRANT SELECT, INSERT, UPDATE ON workspaces TO rci_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships, accounts, raw_objects, datasets, import_jobs, dataset_versions,
  summary_window_facts, campaigns, campaign_launch_facts, report_snapshots, jobs, idempotency_keys TO rci_app;
GRANT SELECT, INSERT ON events TO rci_app;
-- Audit history is append-only for the application.
GRANT SELECT, INSERT ON audit_events TO rci_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rci_app;
