# AI provider setup and evaluation

**Gemini or ChatGPT, one key for all four tools.** Set `AI_PROVIDER=gemini` or `AI_PROVIDER=openai` (ChatGPT), plus `AI_MODEL` and `AI_API_KEY`.
- The AI service's host is allowed automatically.
- With `RESPONSYS_DIR` set, Responsys gets the same provider, key and model when the platform starts it.
- Set `RESPONSYS_SHARE_AI=false` to stop sharing.

**Supported providers.** `AI_PROVIDER=gemini` (Google Generative Language `generateContent`) or `openai-compatible` (`/chat/completions`). Set `AI_MODEL`, `AI_API_KEY` and, for compatible providers, `AI_BASE_URL`. Add the provider host (for example `generativelanguage.googleapis.com`) to `OUTBOUND_HOSTS`. Keys stay on the server and are never sent to the browser.

**Runtime limits.** These are set in `.env`:
- `AI_TIMEOUT_MS` (default 30 000);
- `AI_DAILY_LIMIT` per workspace (default 100);
- one bounded retry for transient 429/5xx responses;
- token usage recorded per run (admin endpoint `/api/ai/usage`).

No cost is calculated, because prices are not invented. Multiply the recorded tokens by your contracted rate.

**What the model sees.** Aggregated metrics (ID, label, value, formula, state), findings, capabilities, limitations and up to 20 approved playbooks (excerpts). It never sees raw record contents.

**What the model may do.**
1. Optionally request up to three allowlisted tools:
   - `list_datasets`
   - `get_metric` (this source only)
   - `compare_records`
   - `inspect_coverage`
   - `check_rule`
   - `get_playbook_excerpt`
   - `propose_action` (not saved)

   Every tool call re-checks the user's permission and is confined to the report's source.
2. Return statements typed as observation, hypothesis, recommendation or limitation, each citing metric, finding, playbook or tool IDs.

**Validation, with a labeled rule-based fallback on failure.** An answer is rejected when:
- it is not valid JSON;
- it cites an unknown or another tenant's ID;
- a statement has no citation;
- it contains digits (values are rendered from verified metrics instead);
- it makes causal claims outside hypotheses;
- the response was truncated;
- the call timed out, the key is missing, or the provider failed.

**Evaluation before go-live.**
1. Configure the key.
2. Ask the suggested questions on a real snapshot.
3. Check that every statement resolves to evidence.
4. Ask an off-topic question and an "ignore your rules" question: both must stay grounded or fall back.
5. Record the model, date and results in `IMPLEMENTATION_STATUS.md`.

**Status.** Contract-tested with simulated responses (labeled fixtures). No live provider response has been verified in this build.
