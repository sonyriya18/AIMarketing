// Schema for the separate Oracle AI Assessment Platform database. Never point this at the
// Responsys database. Every tenant-owned table carries workspace_id and a row-level policy.
export const APP_TABLES = ["eloqua", "unity", "infinity"] as const;
export const tenantTables = [
  "stream_events",
  "sources",
  "source_grants",
  "connections",
  "datasets",
  ...APP_TABLES.map((a) => a + "_records"),
  "reports",
  "actions",
  "notifications",
  "knowledge",
  "ai_runs",
  "audit",
  "jobs",
  "scenarios",
  "drafts",
  "draft_revisions",
  "investigations",
  "feedback",
  "schedules",
  "cross_mappings",
];
export const schema = `
CREATE TABLE IF NOT EXISTS schema_version(version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO schema_version(version) VALUES(2) ON CONFLICT DO NOTHING;
INSERT INTO schema_version(version) VALUES(3) ON CONFLICT DO NOTHING;
INSERT INTO schema_version(version) VALUES(4) ON CONFLICT DO NOTHING;
INSERT INTO schema_version(version) VALUES(5) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS users(id text PRIMARY KEY,email text UNIQUE NOT NULL,issuer text,subject text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(issuer,subject));
CREATE TABLE IF NOT EXISTS workspaces(id text PRIMARY KEY,name text NOT NULL,slug text UNIQUE NOT NULL,logo text,created_at timestamptz DEFAULT now());
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active' CHECK(status IN('active','suspended'));
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS responsys_url text;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS brand jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS responsys_workspace_id text;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS responsys_account_id text;
CREATE TABLE IF NOT EXISTS platform_admins(user_id text PRIMARY KEY REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS memberships(workspace_id text NOT NULL REFERENCES workspaces(id),user_id text NOT NULL REFERENCES users(id),role text NOT NULL CHECK(role IN('owner','analyst','viewer')),apps jsonb NOT NULL DEFAULT '[]',permissions jsonb NOT NULL DEFAULT '[]',PRIMARY KEY(workspace_id,user_id));
CREATE TABLE IF NOT EXISTS entitlements(workspace_id text NOT NULL REFERENCES workspaces(id),app text NOT NULL CHECK(app IN('responsys','eloqua','unity','infinity')),enabled boolean NOT NULL DEFAULT true,starts_at timestamptz,ends_at timestamptz,PRIMARY KEY(workspace_id,app));
CREATE TABLE IF NOT EXISTS sessions(token_hash text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id),workspace_id text REFERENCES workspaces(id),csrf text NOT NULL,expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS sso_codes(code_hash text PRIMARY KEY,value jsonb NOT NULL,expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS sso_keys(kid text PRIMARY KEY,private_key text NOT NULL,public_jwk jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS oidc_states(state text PRIMARY KEY,value jsonb NOT NULL,expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS sources(id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id),app text NOT NULL CHECK(app IN('eloqua','unity','infinity')),name text NOT NULL,environment text NOT NULL DEFAULT 'production' CHECK(environment IN('production','test','sandbox')),timezone text NOT NULL,currency text NOT NULL,visibility text NOT NULL CHECK(visibility IN('workspace','restricted')),policy jsonb NOT NULL DEFAULT '{}',created_at timestamptz DEFAULT now(),UNIQUE(workspace_id,id));
CREATE TABLE IF NOT EXISTS source_grants(workspace_id text NOT NULL,source_id text NOT NULL,user_id text NOT NULL REFERENCES users(id),PRIMARY KEY(source_id,user_id),FOREIGN KEY(workspace_id,source_id) REFERENCES sources(workspace_id,id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS connections(id text PRIMARY KEY,workspace_id text NOT NULL,source_id text NOT NULL,config jsonb NOT NULL,secrets text NOT NULL,status text NOT NULL DEFAULT 'not_checked',verification text NOT NULL DEFAULT 'configured' CHECK(verification IN('configured','connectivity_tested','sample_reconciled','production_validated')),capabilities jsonb NOT NULL DEFAULT '{}',last_error text,last_checked_at timestamptz,last_success_at timestamptz,last_attempt_at timestamptz,next_sync_at timestamptz,sync_minutes int NOT NULL DEFAULT 1440 CHECK(sync_minutes>=1),enabled boolean NOT NULL DEFAULT false,owned_resources jsonb NOT NULL DEFAULT '[]',FOREIGN KEY(workspace_id,source_id) REFERENCES sources(workspace_id,id),UNIQUE(workspace_id,id));
CREATE TABLE IF NOT EXISTS datasets(id text PRIMARY KEY,workspace_id text NOT NULL,source_id text NOT NULL,name text NOT NULL,mode text NOT NULL CHECK(mode IN('upload','connected','stream')),fingerprint text NOT NULL,as_of timestamptz NOT NULL,coverage_start text,coverage_end text,active boolean NOT NULL DEFAULT false,row_count int NOT NULL,metadata jsonb NOT NULL DEFAULT '{}',created_by text,redacted_at timestamptz,created_at timestamptz DEFAULT now(),UNIQUE(workspace_id,id),FOREIGN KEY(workspace_id,source_id) REFERENCES sources(workspace_id,id),UNIQUE(source_id,fingerprint));
CREATE UNIQUE INDEX IF NOT EXISTS dataset_active_idx ON datasets(source_id) WHERE active;
${APP_TABLES.map((app) => `CREATE TABLE IF NOT EXISTS ${app}_records(workspace_id text NOT NULL,dataset_id text NOT NULL,source_id text NOT NULL,external_id text NOT NULL,entity_type text NOT NULL,data jsonb NOT NULL,PRIMARY KEY(dataset_id,entity_type,external_id),FOREIGN KEY(workspace_id,dataset_id) REFERENCES datasets(workspace_id,id) ON DELETE CASCADE,FOREIGN KEY(workspace_id,source_id) REFERENCES sources(workspace_id,id));`).join("\n")}
CREATE TABLE IF NOT EXISTS reports(id text PRIMARY KEY,workspace_id text NOT NULL,source_id text NOT NULL,dataset_id text NOT NULL,created_by text NOT NULL REFERENCES users(id),result jsonb NOT NULL,saved boolean NOT NULL DEFAULT false,title text,redacted_at timestamptz,created_at timestamptz DEFAULT now(),FOREIGN KEY(workspace_id,source_id) REFERENCES sources(workspace_id,id),FOREIGN KEY(workspace_id,dataset_id) REFERENCES datasets(workspace_id,id));
CREATE INDEX IF NOT EXISTS reports_source_idx ON reports(source_id,created_at);
CREATE TABLE IF NOT EXISTS actions(id text PRIMARY KEY,workspace_id text NOT NULL,source_id text NOT NULL,report_id text REFERENCES reports(id),finding_id text,rule text,target_metric text,baseline jsonb,outcome jsonb,priority text NOT NULL DEFAULT 'medium',title text NOT NULL,detail text NOT NULL,intervention text NOT NULL DEFAULT '',completion_notes text NOT NULL DEFAULT '',assignee text,due_date text,state text NOT NULL CHECK(state IN('open','accepted','in_progress','dismissed','resolved')),version int NOT NULL DEFAULT 1,created_by text NOT NULL,updated_at timestamptz DEFAULT now(),FOREIGN KEY(workspace_id,source_id) REFERENCES sources(workspace_id,id));
CREATE TABLE IF NOT EXISTS notifications(id text PRIMARY KEY,workspace_id text NOT NULL,source_id text NOT NULL,message text NOT NULL,kind text NOT NULL,severity text NOT NULL DEFAULT 'info',dedupe_key text NOT NULL,report_id text,read_at timestamptz,acknowledged_at timestamptz,snoozed_until timestamptz,created_at timestamptz DEFAULT now(),UNIQUE(workspace_id,dedupe_key),FOREIGN KEY(workspace_id,source_id) REFERENCES sources(workspace_id,id));
CREATE TABLE IF NOT EXISTS knowledge(id text PRIMARY KEY,workspace_id text NOT NULL,source_id text NOT NULL,title text NOT NULL,content text NOT NULL,format text NOT NULL DEFAULT 'text',status text NOT NULL DEFAULT 'approved' CHECK(status IN('pending','approved','retired')),version int NOT NULL DEFAULT 1,sha256 text,created_by text,created_at timestamptz DEFAULT now(),FOREIGN KEY(workspace_id,source_id) REFERENCES sources(workspace_id,id));
CREATE TABLE IF NOT EXISTS ai_runs(id text PRIMARY KEY,workspace_id text NOT NULL,source_id text NOT NULL,report_id text NOT NULL REFERENCES reports(id),user_id text NOT NULL,purpose text NOT NULL DEFAULT 'chat',question text NOT NULL,result jsonb,provider text NOT NULL,model text,status text NOT NULL,usage jsonb NOT NULL DEFAULT '{}',tool_calls jsonb NOT NULL DEFAULT '[]',created_at timestamptz DEFAULT now(),FOREIGN KEY(workspace_id,source_id) REFERENCES sources(workspace_id,id));
CREATE TABLE IF NOT EXISTS audit(id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id),user_id text,event text NOT NULL,resource_id text,detail jsonb NOT NULL DEFAULT '{}',created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS jobs(id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id),source_id text NOT NULL,connection_id text NOT NULL,kind text NOT NULL CHECK(kind IN('check','sync')),state text NOT NULL DEFAULT 'queued' CHECK(state IN('queued','running','succeeded','failed','cancelled')),attempts int NOT NULL DEFAULT 0,lease_until timestamptz,available_at timestamptz DEFAULT now(),checkpoint jsonb NOT NULL DEFAULT '{}',progress jsonb NOT NULL DEFAULT '{}',result jsonb,last_error text,failed_stage text,created_by text NOT NULL,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS job_active_idx ON jobs(connection_id) WHERE state IN('queued','running');
CREATE TABLE IF NOT EXISTS scenarios(id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id),source_id text NOT NULL,report_id text NOT NULL REFERENCES reports(id),input jsonb NOT NULL,result jsonb NOT NULL,created_by text NOT NULL,created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS stream_events(workspace_id text NOT NULL REFERENCES workspaces(id),source_id text NOT NULL,external_id text NOT NULL,data jsonb NOT NULL,received_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(source_id,external_id),FOREIGN KEY(workspace_id,source_id) REFERENCES sources(workspace_id,id));
CREATE INDEX IF NOT EXISTS stream_received_idx ON stream_events(source_id,received_at);
CREATE TABLE IF NOT EXISTS drafts(id text PRIMARY KEY,workspace_id text NOT NULL,source_id text NOT NULL,report_id text REFERENCES reports(id),finding_id text,draft_type text NOT NULL,title text NOT NULL,content jsonb NOT NULL,status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','in_review','approved','rejected')),generator text NOT NULL DEFAULT 'manual',version int NOT NULL DEFAULT 1,created_by text NOT NULL,reviewed_by text,updated_at timestamptz DEFAULT now(),FOREIGN KEY(workspace_id,source_id) REFERENCES sources(workspace_id,id));
CREATE TABLE IF NOT EXISTS draft_revisions(id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id),draft_id text NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,version int NOT NULL,content jsonb NOT NULL,status text NOT NULL,note text NOT NULL DEFAULT '',created_by text NOT NULL,created_at timestamptz DEFAULT now(),UNIQUE(draft_id,version));
CREATE TABLE IF NOT EXISTS investigations(id text PRIMARY KEY,workspace_id text NOT NULL,source_id text NOT NULL,report_id text NOT NULL REFERENCES reports(id),finding_id text NOT NULL,title text NOT NULL,hypotheses jsonb NOT NULL DEFAULT '[]',checks jsonb NOT NULL DEFAULT '[]',notes text NOT NULL DEFAULT '',status text NOT NULL DEFAULT 'open' CHECK(status IN('open','closed')),version int NOT NULL DEFAULT 1,created_by text NOT NULL,updated_at timestamptz DEFAULT now(),FOREIGN KEY(workspace_id,source_id) REFERENCES sources(workspace_id,id));
CREATE TABLE IF NOT EXISTS feedback(id text PRIMARY KEY,workspace_id text NOT NULL,source_id text NOT NULL,report_id text REFERENCES reports(id),finding_id text NOT NULL,rule text,verdict text NOT NULL CHECK(verdict IN('useful','dismissed','completed')),reason text NOT NULL DEFAULT '',minutes_spent int CHECK(minutes_spent IS NULL OR minutes_spent BETWEEN 0 AND 10000),created_by text NOT NULL,created_at timestamptz DEFAULT now(),FOREIGN KEY(workspace_id,source_id) REFERENCES sources(workspace_id,id));
CREATE TABLE IF NOT EXISTS schedules(id text PRIMARY KEY,workspace_id text NOT NULL,source_id text NOT NULL,cadence text NOT NULL CHECK(cadence IN('daily','weekly')),enabled boolean NOT NULL DEFAULT true,next_run_at timestamptz NOT NULL,last_run_at timestamptz,last_report_id text,last_findings jsonb NOT NULL DEFAULT '[]',created_by text NOT NULL,created_at timestamptz DEFAULT now(),UNIQUE(source_id),FOREIGN KEY(workspace_id,source_id) REFERENCES sources(workspace_id,id));
CREATE TABLE IF NOT EXISTS cross_mappings(id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id),name text NOT NULL,left_source text NOT NULL,left_entity text NOT NULL,left_field text NOT NULL,right_source text NOT NULL,right_entity text NOT NULL,right_field text NOT NULL,normalization text NOT NULL DEFAULT 'exact' CHECK(normalization IN('exact','lowercase-trim')),approved_by text NOT NULL,created_at timestamptz DEFAULT now());
${tenantTables
  .map(
    (t) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename='${t}' AND policyname='tenant_scope') THEN CREATE POLICY tenant_scope ON ${t} USING(workspace_id=current_setting('app.workspace_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true)); END IF; END $$;`,
  )
  .join("\n")}
`;
