-- 002: provider connections, Connect diagnostics, reporting partitions, scenarios, drafts,
-- approvals, external operations, chat and AI runs.

-- ---------------------------------------------------------------- Responsys connections
CREATE TABLE connections (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('responsys')),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  login_base_url text NOT NULL,
  -- Reference to server-side secret material (never the secret itself).
  credential_ref text NOT NULL CHECK (credential_ref ~ '^(file|env):[A-Za-z0-9_.-]{1,80}$'),
  status text NOT NULL DEFAULT 'not_checked' CHECK (status IN ('not_checked', 'checking', 'available', 'unavailable', 'denied', 'degraded', 'disabled')),
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  service_endpoint text,
  last_checked_at timestamptz,
  last_error text,
  sync_enabled boolean NOT NULL DEFAULT false,
  reporting_dataset_id uuid,
  last_sync_attempt_at timestamptz,
  last_successful_sync_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES accounts (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, reporting_dataset_id) REFERENCES datasets (workspace_id, id)
);

CREATE TABLE connect_jobs (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  external_job_id text NOT NULL,
  name text NOT NULL,
  job_type text,
  is_event_feed boolean NOT NULL DEFAULT false,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (workspace_id, id),
  UNIQUE (connection_id, external_job_id),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES connections (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, account_id) REFERENCES accounts (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE connect_job_runs (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  connect_job_id uuid NOT NULL,
  external_run_id text NOT NULL,
  provider_state text,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'aborted', 'unknown')),
  started_at timestamptz,
  ended_at timestamptz,
  records_processed bigint,
  records_rejected bigint,
  error_category text,
  error_redacted text,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (connect_job_id, external_run_id),
  FOREIGN KEY (workspace_id, connect_job_id) REFERENCES connect_jobs (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE reporting_requests (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL,
  account_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email', 'sms', 'mobileapps')),
  send_from_date date NOT NULL,
  send_to_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('planned', 'submitted', 'pending', 'received', 'split', 'failed', 'activated')),
  provider_request_id text,
  attempts int NOT NULL DEFAULT 0,
  row_count int,
  bytes int,
  error text,
  result jsonb,
  sync_run_id uuid NOT NULL,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CHECK (send_from_date <= send_to_date),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES connections (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, account_id) REFERENCES accounts (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX reporting_requests_conn_idx ON reporting_requests (connection_id, submitted_at);

-- ---------------------------------------------------------------- scenarios
CREATE TABLE scenario_runs (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  baseline_report_id uuid,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  algorithm_version text NOT NULL,
  inputs jsonb NOT NULL,
  input_hash text NOT NULL,
  output jsonb NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES accounts (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, baseline_report_id) REFERENCES report_snapshots (workspace_id, id)
);

-- ---------------------------------------------------------------- drafts and versions
CREATE TABLE drafts (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  primary_channel text NOT NULL CHECK (primary_channel IN ('Email', 'SMS', 'WebPush')),
  current_version int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  source jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES accounts (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE draft_versions (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL,
  version int NOT NULL CHECK (version >= 1),
  content jsonb NOT NULL,
  content_hash text NOT NULL,
  validation jsonb NOT NULL DEFAULT '{}'::jsonb,
  change_note text,
  origin text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'ai_accepted', 'template')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (workspace_id, id),
  UNIQUE (draft_id, version),
  FOREIGN KEY (workspace_id, draft_id) REFERENCES drafts (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE approvals (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  draft_version_id uuid NOT NULL,
  content_hash text NOT NULL,
  action_type text NOT NULL CHECK (action_type IN ('provider_draft_create', 'proof_send', 'live_schedule')),
  action_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  params_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'invalidated', 'expired', 'consumed')),
  requested_by uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_note text,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, draft_id) REFERENCES drafts (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, draft_version_id) REFERENCES draft_versions (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, account_id) REFERENCES accounts (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE external_operations (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  operation_type text NOT NULL CHECK (operation_type IN ('provider_draft_create', 'proof_send', 'live_schedule', 'connect_trigger')),
  status text NOT NULL CHECK (status IN ('requested', 'awaiting_approval', 'approved', 'queued', 'submitting', 'accepted_by_provider',
                                         'reconciling', 'confirmed', 'failed', 'cancelled', 'outcome_unknown', 'blocked')),
  draft_version_id uuid,
  approval_id uuid,
  idempotency_key text NOT NULL,
  request jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_response jsonb,
  external_ref text,
  error text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, account_id) REFERENCES accounts (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, draft_version_id) REFERENCES draft_versions (workspace_id, id),
  FOREIGN KEY (workspace_id, approval_id) REFERENCES approvals (workspace_id, id)
);
-- At most one live operation per approval: a repeated click cannot launch twice.
CREATE UNIQUE INDEX external_operations_one_per_approval ON external_operations (approval_id) WHERE approval_id IS NOT NULL AND status NOT IN ('failed', 'cancelled', 'blocked');

-- ---------------------------------------------------------------- chat and AI runs
CREATE TABLE ai_runs (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid,
  purpose text NOT NULL CHECK (purpose IN ('chat', 'report_explanation', 'draft_change')),
  provider text NOT NULL,
  model text,
  prompt_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('completed', 'failed', 'disabled', 'rate_limited', 'rejected')),
  evidence_hash text,
  input_tokens int,
  output_tokens int,
  latency_ms int,
  error text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (workspace_id, id)
);
CREATE INDEX ai_runs_budget_idx ON ai_runs (workspace_id, created_at);

CREATE TABLE chat_threads (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  report_id uuid NOT NULL,
  title text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES accounts (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, report_id) REFERENCES report_snapshots (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE chat_messages (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  answer jsonb,
  ai_run_id uuid,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  FOREIGN KEY (workspace_id, thread_id) REFERENCES chat_threads (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, ai_run_id) REFERENCES ai_runs (workspace_id, id)
);
CREATE INDEX chat_messages_thread_idx ON chat_messages (thread_id, created_at);

-- Connections due for a scheduled sync, across tenants (narrow SECURITY DEFINER read).
CREATE FUNCTION rci_due_connections(p_interval_minutes int)
RETURNS TABLE (workspace_id uuid, connection_id uuid) LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT c.workspace_id, c.id FROM connections c
   WHERE c.sync_enabled AND c.status IN ('available', 'degraded')
     AND (c.last_sync_attempt_at IS NULL OR c.last_sync_attempt_at < now() - make_interval(mins => p_interval_minutes))
$$;
REVOKE ALL ON FUNCTION rci_due_connections(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rci_due_connections(int) TO rci_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['connections', 'connect_jobs', 'connect_job_runs', 'reporting_requests', 'scenario_runs', 'drafts',
                           'draft_versions', 'approvals', 'external_operations', 'ai_runs', 'chat_threads', 'chat_messages']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (workspace_id = rci_ws()) WITH CHECK (workspace_id = rci_ws())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO rci_app', t);
  END LOOP;
END $$;
-- Draft versions are immutable history: the application may add, never rewrite.
REVOKE UPDATE, DELETE ON draft_versions FROM rci_app;
