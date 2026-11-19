-- Optional source columns for content and offer analysis (as written in the import file).
ALTER TABLE campaign_launch_facts ADD COLUMN creative_type text;
ALTER TABLE campaign_launch_facts ADD COLUMN offer text;

-- AI page summaries, cached per immutable report snapshot. Only AI-written results are cached;
-- the rule-based summary is recomputed from the snapshot. Rows are never rewritten.
CREATE TABLE report_ai_summaries (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL,
  focus text NOT NULL CHECK (focus IN ('page', 'simulator')),
  prompt_version text NOT NULL,
  result jsonb NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (report_id, focus, prompt_version),
  FOREIGN KEY (workspace_id, report_id) REFERENCES report_snapshots (workspace_id, id) ON DELETE CASCADE
);
ALTER TABLE report_ai_summaries ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON report_ai_summaries USING (workspace_id = rci_ws()) WITH CHECK (workspace_id = rci_ws());
GRANT SELECT, INSERT ON report_ai_summaries TO rci_app;
