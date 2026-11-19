import React, { useEffect, useState } from "react";
import {
  BookOpen,
  CalendarClock,
  Cloud,
  Download,
  ExternalLink,
  FileUp,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { api } from "./api";
import { Button, Panel, Field, ErrorBox, Empty, date } from "./ui";
import {
  PRODUCTS,
  ENTITY_TYPES,
  ROLE_LABEL,
  product,
  type AppId,
  type Source,
  type Session,
  type Role,
} from "../shared/catalog";
import { FIELDS } from "../shared/fields";

// Suggested starting policy per application. Every value is editable and shown in reports.
const policies: Record<AppId, Record<string, unknown>> = {
  eloqua: {
    minSends: 100,
    bounceRateThreshold: 5,
    unsubscribeRateThreshold: 0.5,
    ctorGapPp: 5,
    activityLookbackDays: 3,
    attributionWindowDays: 7,
  },
  unity: {
    requiredFields: ["email"],
    staleDays: 30,
    snapshotToleranceHours: 1,
  },
  infinity: {
    funnelWindowMinutes: 30,
    funnelIdentity: "session",
    dropThreshold: 30,
    lateMinutes: 60,
    minHistoryDays: 14,
  },
};
const can = (s: Session, p: "connectors" | "approvals") =>
  !!s.workspace?.permissions?.includes(p);

export function NewSource({ app, onDone }: { app: AppId; onDone: () => void }) {
  // A ready name, so one click creates the source (it can be changed).
  const [name, setName] = useState(`${product(app).short} — Production`),
    [environment, setEnvironment] = useState("production"),
    [timezone, setTimezone] = useState(
      Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    ),
    [currency, setCurrency] = useState("USD"),
    [visibility, setVisibility] = useState("workspace"),
    [members, setMembers] = useState<any[]>([]),
    [grants, setGrants] = useState<string[]>([]),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api("/settings")
      .then((r) => setMembers(r.members))
      .catch(setError);
  }, []);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/sources", {
        app,
        name,
        environment,
        timezone,
        currency,
        visibility,
        userIds: grants,
        policy: policies[app],
      });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel
      title={"Add " + product(app).short + " source account"}
      subtitle="A source account is one authorized Oracle instance or environment (for example production or test) whose data you upload or connect."
    >
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="Source account / environment name">
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`e.g. ${product(app).short} — Production`}
            />
          </Field>
          <Field label="Environment">
            <select
              value={environment}
              onChange={(e) => setEnvironment(e.target.value)}
            >
              <option value="production">Production</option>
              <option value="test">Test</option>
              <option value="sandbox">Sandbox</option>
            </select>
          </Field>
          <Field label="Account timezone">
            <input
              required
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
            />
          </Field>
          <Field label="Reporting currency">
            <input
              required
              maxLength={3}
              pattern="[A-Z]{3}"
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            />
          </Field>
        </div>
        <Field
          label="Who may use this source?"
          hint="Access is enforced on every request. An Oracle integration user's permissions may be broader than each analyst's."
        >
          <select
            value={visibility}
            onChange={(e) => setVisibility(e.target.value)}
          >
            <option value="workspace">
              All members with access to this application
            </option>
            <option value="restricted">
              Only administrators and selected members
            </option>
          </select>
        </Field>
        {visibility === "restricted" && (
          <fieldset>
            <legend>Authorized members</legend>
            {members.map((m) => (
              <label className="checkbox" key={m.id}>
                <input
                  type="checkbox"
                  checked={grants.includes(m.id)}
                  onChange={(e) =>
                    setGrants(
                      e.target.checked
                        ? [...grants, m.id]
                        : grants.filter((x) => x !== m.id),
                    )
                  }
                />
                {m.email}
              </label>
            ))}
          </fieldset>
        )}
        <Button primary busy={busy}>
          Create source account
        </Button>
        <ErrorBox error={error} />
      </form>
    </Panel>
  );
}

export function DataPage({
  source,
  session,
  onDone,
  notify,
}: {
  source: Source;
  session: Session;
  onDone: () => void;
  notify: (s: string) => void;
}) {
  const [connections, setConnections] = useState<any[]>([]),
    [jobs, setJobs] = useState<any[]>([]),
    [datasets, setDatasets] = useState<any[]>([]),
    [knowledge, setKnowledge] = useState<any[]>([]),
    [schedule, setSchedule] = useState<any>(null),
    [error, setError] = useState<unknown>(null),
    [showConnect, setShowConnect] = useState(false),
    [policy, setPolicy] = useState(JSON.stringify(source.policy, null, 2));
  const admin = session.workspace?.role === "owner",
    write = session.workspace?.role !== "viewer",
    connectors = can(session, "connectors"),
    approvals = can(session, "approvals");
  const load = async (signal?: AbortSignal) => {
    const r = await Promise.all([
      api(
        "/sources/" + source.id + "/connections",
        undefined,
        undefined,
        signal,
      ),
      api("/sources/" + source.id + "/jobs", undefined, undefined, signal),
      api("/sources/" + source.id + "/datasets", undefined, undefined, signal),
      api("/sources/" + source.id + "/knowledge", undefined, undefined, signal),
      api("/sources/" + source.id + "/schedule", undefined, undefined, signal),
    ]);
    setConnections(r[0]);
    setJobs(r[1]);
    setDatasets(r[2]);
    setKnowledge(r[3]);
    setSchedule(r[4]);
  };
  useEffect(() => {
    const c = new AbortController();
    const run = () =>
      load(c.signal).catch((e) => e.name !== "AbortError" && setError(e));
    void run();
    const t = setInterval(run, 5000); // browser polling for job status, not source freshness
    return () => {
      c.abort();
      clearInterval(t);
    };
  }, [source.id]);
  const act = async (fn: () => Promise<unknown>, message?: string) => {
    setError(null);
    try {
      await fn();
      await load();
      if (message) notify(message);
    } catch (e) {
      setError(e);
    }
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">DATA &amp; CONNECTIONS</span>
          <h1>{source.name}</h1>
          <p>
            {source.environment || "production"} environment · {source.timezone}{" "}
            · Upload real exports or connect your authorized Oracle instance.
          </p>
        </div>
        <Button onClick={onDone}>
          <RefreshCw size={16} /> Load latest assessment
        </Button>
      </div>
      <ErrorBox error={error} />
      {write && (
        <ImportPanel
          source={source}
          onDone={(message) => {
            void load();
            notify(
              message ||
                "Dataset imported. Use Load latest assessment to view it.",
            );
          }}
        />
      )}
      <Panel
        title="Oracle connections"
        subtitle="Configured, connectivity-tested, sample-reconciled and production-validated are different states. A successful check does not certify completeness."
        extra={
          connectors ? (
            <Button onClick={() => setShowConnect(!showConnect)}>
              <Cloud size={16} /> Add connection
            </Button>
          ) : undefined
        }
      >
        {connections.length ? (
          connections.map((c) => (
            <article className="connection" key={c.id}>
              <div className="connection-head">
                <div>
                  <h3>{new URL(c.config.baseUrl).hostname}</h3>
                  <span className={"status " + c.status}>
                    {c.status.replaceAll("_", " ")}
                  </span>{" "}
                  <span className="badge">
                    {c.verification.replaceAll("_", " ")}
                  </span>
                </div>
                {connectors && (
                  <div className="button-row">
                    <Button
                      onClick={() =>
                        act(
                          () => api("/connections/" + c.id + "/check", {}),
                          "Connection check queued.",
                        )
                      }
                    >
                      Test connection
                    </Button>
                    <Button
                      primary
                      onClick={() =>
                        act(
                          () => api("/connections/" + c.id + "/sync", {}),
                          "Synchronization queued.",
                        )
                      }
                    >
                      Sync now
                    </Button>
                    {c.config.auth === "oauth" && (
                      <a
                        className="button"
                        href={"/api/connections/" + c.id + "/authorize"}
                      >
                        Authorize source <ExternalLink size={14} />
                      </a>
                    )}
                  </div>
                )}
              </div>
              <dl className="connection-stats">
                <dt>Last attempt</dt>
                <dd>{date(c.last_attempt_at)}</dd>
                <dt>Last successful sync</dt>
                <dd>{date(c.last_success_at)}</dd>
                <dt>Next scheduled refresh</dt>
                <dd>{c.enabled ? date(c.next_sync_at) : "Schedule paused"}</dd>
              </dl>
              {c.last_error && (
                <div className="notice warning">{c.last_error}</div>
              )}
              {c.owned_resources?.length > 0 && (
                <div className="notice warning">
                  Temporary export resources left in Oracle for administrator
                  clean-up: {c.owned_resources.join(", ")}
                </div>
              )}
              <details>
                <summary>Resource capabilities</summary>
                <pre>{JSON.stringify(c.capabilities, null, 2)}</pre>
              </details>
              {connectors && (
                <div className="button-row">
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={c.enabled}
                      onChange={(e) =>
                        act(() =>
                          api(
                            "/connections/" + c.id,
                            { enabled: e.target.checked },
                            "PATCH",
                          ),
                        )
                      }
                    />
                    Scheduled refresh every {c.sync_minutes} minutes
                  </label>
                  <Field label="Refresh interval (minutes)">
                    <input
                      type="number"
                      min={1}
                      max={10080}
                      defaultValue={c.sync_minutes}
                      onBlur={(e) =>
                        act(() =>
                          api(
                            "/connections/" + c.id,
                            { syncMinutes: Number(e.target.value) },
                            "PATCH",
                          ),
                        )
                      }
                    />
                  </Field>
                  <Button
                    onClick={() =>
                      confirm(
                        "Disconnect this source? Saved report snapshots remain.",
                      ) && act(() => api("/connections/" + c.id, {}, "DELETE"))
                    }
                  >
                    Disconnect
                  </Button>
                  {admin && c.last_success_at && (
                    <details>
                      <summary>Record reconciliation evidence</summary>
                      <ReconcileForm id={c.id} onDone={() => void load()} />
                    </details>
                  )}
                  <details>
                    <summary>Rotate credentials</summary>
                    <SecretRotation connection={c} onDone={() => void load()} />
                  </details>
                </div>
              )}
            </article>
          ))
        ) : (
          <p className="muted">
            No Oracle connection is configured. Uploaded exports work
            independently.
          </p>
        )}
        {showConnect && (
          <ConnectionForm
            source={source}
            onDone={() => {
              setShowConnect(false);
              void load();
            }}
          />
        )}
      </Panel>
      <Panel title="Synchronization jobs">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Operation</th>
                <th>Status</th>
                <th>Updated</th>
                <th>Result</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td>{j.kind}</td>
                  <td>
                    <span className="badge">{j.state}</span>
                  </td>
                  <td>{date(j.updated_at)}</td>
                  <td>
                    {j.last_error
                      ? `${j.failed_stage ? j.failed_stage + ": " : ""}${j.last_error}`
                      : j.result
                        ? `${j.result.rows} records`
                        : j.progress?.stage || "Waiting for worker"}
                  </td>
                  <td>
                    {connectors && ["queued", "running"].includes(j.state) && (
                      <Button
                        onClick={() =>
                          act(() => api("/jobs/" + j.id + "/cancel", {}))
                        }
                      >
                        Cancel
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!jobs.length && <p className="muted">No jobs yet.</p>}
        </div>
      </Panel>
      <Panel
        title="Dataset versions"
        subtitle="Each import or sync is an immutable snapshot. Activating an older version never changes saved reports."
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Dataset</th>
                <th>Mode</th>
                <th>Rows</th>
                <th>Completeness</th>
                <th>As of</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {datasets.map((d) => (
                <tr key={d.id}>
                  <td>
                    {d.name} {d.active && <span className="badge">Active</span>}{" "}
                    {d.redacted_at && <span className="badge">Deleted</span>}
                  </td>
                  <td>{d.mode}</td>
                  <td>{d.row_count}</td>
                  <td>
                    {d.redacted_at
                      ? "—"
                      : d.metadata?.completeness === "partial"
                        ? `Partial (${d.metadata.quarantinedRows || 0} rows quarantined)`
                        : "Complete"}
                  </td>
                  <td>{date(d.as_of)}</td>
                  <td className="button-row">
                    {write && !d.active && !d.redacted_at && (
                      <Button
                        onClick={() =>
                          act(
                            () => api("/datasets/" + d.id + "/activate", {}),
                            "Dataset activated.",
                          )
                        }
                      >
                        Activate
                      </Button>
                    )}
                    {admin && !d.redacted_at && (
                      <Button
                        aria-label={"Delete dataset " + d.name}
                        onClick={() => {
                          const typed = prompt(
                            `Deleting removes imported records and redacts reports built from them. Type the dataset name to confirm:\n${d.name}`,
                          );
                          if (typed)
                            void act(
                              () =>
                                api(
                                  "/datasets/" + d.id,
                                  { confirm: typed },
                                  "DELETE",
                                ),
                              "Dataset deleted and derived reports redacted.",
                            );
                        }}
                      >
                        <Trash2 size={14} /> Delete
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel
        title="Scheduled assessment"
        subtitle="Creates an internal digest and notifications. No email or Slack messages are sent."
      >
        <SchedulePanel
          source={source}
          schedule={schedule}
          writable={write}
          onDone={() => act(async () => undefined, "Schedule saved.")}
        />
      </Panel>
      <Panel
        title="Approved playbooks"
        subtitle="Text or Markdown guidance the AI may cite. Uploaded text is treated as data, never as instructions. A reviewer with approval permission must approve it first."
      >
        {write && (
          <PlaybookUpload
            source={source}
            onDone={() =>
              act(
                async () => undefined,
                "Playbook uploaded and waiting for approval.",
              )
            }
          />
        )}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Version</th>
                <th>Status</th>
                <th>Added</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {knowledge.map((k) => (
                <tr key={k.id}>
                  <td>{k.title}</td>
                  <td>{k.version}</td>
                  <td>
                    <span className="badge">{k.status}</span>
                  </td>
                  <td>
                    {date(k.created_at)} · {k.created_by}
                  </td>
                  <td className="button-row">
                    {approvals && k.status === "pending" && (
                      <Button
                        onClick={() =>
                          act(
                            () => api("/knowledge/" + k.id + "/approve", {}),
                            "Playbook approved.",
                          )
                        }
                      >
                        Approve
                      </Button>
                    )}
                    {approvals && k.status !== "retired" && (
                      <Button
                        onClick={() =>
                          act(() => api("/knowledge/" + k.id + "/retire", {}))
                        }
                      >
                        Retire
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!knowledge.length && <p className="muted">No playbooks yet.</p>}
        </div>
      </Panel>
      {admin && (
        <Panel
          title="Assessment policy"
          subtitle="Thresholds and definitions used by this source's rules. They never change Oracle configuration."
        >
          <textarea
            aria-label="Assessment policy JSON"
            className="code-input"
            rows={10}
            value={policy}
            onChange={(e) => setPolicy(e.target.value)}
          />
          <Button
            onClick={() =>
              act(async () => {
                let parsed: unknown;
                try {
                  parsed = JSON.parse(policy);
                } catch {
                  throw Error("The policy must be valid JSON");
                }
                await api("/sources/" + source.id, { policy: parsed }, "PATCH");
              }, "Assessment policy saved. Load the latest assessment.")
            }
          >
            Save policy
          </Button>
          <a
            className="button"
            href={"/api/dictionary/" + source.app}
            target="_blank"
            rel="noreferrer"
          >
            <BookOpen size={15} /> Metric and data dictionary
          </a>
        </Panel>
      )}
    </>
  );
}

function SchedulePanel({
  source,
  schedule,
  writable,
  onDone,
}: {
  source: Source;
  schedule: any;
  writable: boolean;
  onDone: () => void;
}) {
  const [cadence, setCadence] = useState(schedule?.cadence || "weekly"),
    [enabled, setEnabled] = useState(schedule ? schedule.enabled : true),
    [error, setError] = useState<unknown>(null),
    [result, setResult] = useState<any>(null);
  useEffect(() => {
    if (schedule) {
      setCadence(schedule.cadence);
      setEnabled(schedule.enabled);
    }
  }, [schedule?.cadence, schedule?.enabled]);
  return (
    <>
      <p className="muted">
        {schedule
          ? `Next run ${date(schedule.next_run_at)} · last run ${date(schedule.last_run_at)}`
          : "No schedule yet."}
      </p>
      {writable && (
        <div className="form-row">
          <Field label="Cadence">
            <select
              value={cadence}
              onChange={(e) => setCadence(e.target.value)}
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </Field>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />{" "}
            Enabled
          </label>
          <Button
            onClick={async () => {
              try {
                await api(
                  "/sources/" + source.id + "/schedule",
                  { cadence, enabled },
                  "PUT",
                );
                onDone();
              } catch (e) {
                setError(e);
              }
            }}
          >
            <CalendarClock size={15} /> Save schedule
          </Button>
          <Button
            onClick={async () => {
              try {
                setResult(
                  await api("/sources/" + source.id + "/schedule/run", {}),
                );
                onDone();
              } catch (e) {
                setError(e);
              }
            }}
          >
            Run digest now
          </Button>
        </div>
      )}
      {result && (
        <div className="notice">
          Digest saved: {result.open} open signals, {result.added} new,{" "}
          {result.resolved} no longer observed.
        </div>
      )}
      <ErrorBox error={error} />
    </>
  );
}

function PlaybookUpload({
  source,
  onDone,
}: {
  source: Source;
  onDone: () => void;
}) {
  const [title, setTitle] = useState(""),
    [content, setContent] = useState(""),
    [format, setFormat] = useState<"text" | "markdown">("text"),
    [error, setError] = useState<unknown>(null);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api("/sources/" + source.id + "/knowledge", {
            title,
            content,
            format,
          });
          setTitle("");
          setContent("");
          onDone();
        } catch (err) {
          setError(err);
        }
      }}
    >
      <div className="form-row">
        <Field label="Playbook title">
          <input
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field
          label="Playbook file (.txt or .md)"
          hint="PDF extraction is not supported in this version; paste extracted text instead."
        >
          <input
            type="file"
            accept=".txt,.md,text/plain,text/markdown"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              if (!/\.(txt|md)$/i.test(f.name) || f.size > 200_000)
                return setError(Error("Use a .txt or .md file up to 200 KB"));
              setFormat(
                f.name.toLowerCase().endsWith(".md") ? "markdown" : "text",
              );
              setTitle((t) => t || f.name.replace(/\.(txt|md)$/i, ""));
              setContent(await f.text());
            }}
          />
        </Field>
      </div>
      <Field label="Guidance text">
        <textarea
          required
          rows={4}
          maxLength={200000}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      </Field>
      <Button>Submit for approval</Button>
      <ErrorBox error={error} />
    </form>
  );
}

interface PendingFile {
  name: string;
  content: string;
  format: "csv" | "json";
  type: string;
}
function ImportPanel({
  source,
  onDone,
}: {
  source: Source;
  onDone: (message?: string) => void;
}) {
  const [files, setFiles] = useState<PendingFile[]>([]),
    [name, setName] = useState(""),
    [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 16)),
    [templateType, setTemplateType] = useState(ENTITY_TYPES[source.app][0]),
    [acceptPartial, setAcceptPartial] = useState(false),
    [partialReason, setPartialReason] = useState(""),
    [preview, setPreview] = useState<any>(),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false);
  const payload = () => ({
    files,
    name: name || files.map((f) => f.name).join(" + "),
    asOf: new Date(asOf).toISOString(),
    acceptPartial,
    partialReason: partialReason || undefined,
  });
  const run = async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api(
        "/sources/" + source.id + "/import/" + path,
        payload(),
      );
      if (path === "preview") setPreview(r);
      else {
        setFiles([]);
        setName("");
        setPreview(undefined);
        setAcceptPartial(false);
        setPartialReason("");
        onDone();
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel
      title="Upload exports"
      subtitle="Add one file or a related batch (for example campaigns + metrics + activities). The batch is validated together and becomes one immutable snapshot."
    >
      <div className="form-row">
        <Field label="Source data as of">
          <input
            type="datetime-local"
            required
            value={asOf}
            onChange={(e) => {
              setAsOf(e.target.value);
              setPreview(undefined);
            }}
          />
        </Field>
        <Field label="Blank template">
          <select
            value={templateType}
            onChange={(e) => setTemplateType(e.target.value)}
          >
            {ENTITY_TYPES[source.app].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </Field>
        <a
          className="button"
          href={"/api/templates/" + source.app + "/" + templateType}
        >
          <Download size={16} /> Download template
        </a>
        <a
          className="button"
          href={"/api/examples/" + source.app}
          title="Clearly synthetic demonstration data; local development only"
        >
          <Download size={16} /> Download sample file
        </a>
        <Button
          title="Imports the clearly synthetic sample straight into this source (local development only)"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const r = await api(
                "/sources/" + source.id + "/examples/load",
                {},
              );
              onDone(
                `Loaded ${r.records} sample records (synthetic). Open Summary to see them.`,
              );
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Sparkles size={16} /> Load sample data
        </Button>
      </div>
      <label className="upload-zone">
        <FileUp size={28} />
        <strong>
          {files.length
            ? `${files.length} file(s) in this batch`
            : "Choose CSV or JSON exports"}
        </strong>
        <span>Up to 10 files, 4 MB each · source IDs required</span>
        <input
          aria-label="Upload data file"
          type="file"
          multiple
          accept=".csv,.json"
          onChange={async (e) => {
            const added: PendingFile[] = [];
            for (const f of Array.from(e.target.files || [])) {
              if (f.size > 4_000_000) {
                setError(Error(`${f.name} exceeds 4 MB`));
                continue;
              }
              const guess =
                ENTITY_TYPES[source.app].find((t) =>
                  f.name.toLowerCase().includes(t),
                ) || "mixed";
              added.push({
                name: f.name,
                content: await f.text(),
                format: f.name.toLowerCase().endsWith(".json") ? "json" : "csv",
                type: guess,
              });
            }
            setFiles((x) => [...x, ...added].slice(0, 10));
            setPreview(undefined);
            e.target.value = "";
          }}
        />
      </label>
      {files.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Data type</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {files.map((f, i) => (
                <tr key={i}>
                  <td>{f.name}</td>
                  <td>
                    <select
                      aria-label={"Data type for " + f.name}
                      value={f.type}
                      onChange={(e) => {
                        setFiles(
                          files.map((x, j) =>
                            j === i ? { ...x, type: e.target.value } : x,
                          ),
                        );
                        setPreview(undefined);
                      }}
                    >
                      {ENTITY_TYPES[source.app].map((t) => (
                        <option key={t} value={t}>
                          {t} ({FIELDS[t].slice(0, 4).join(", ")}…)
                        </option>
                      ))}
                      <option value="mixed">
                        Mixed entities (type column)
                      </option>
                    </select>
                  </td>
                  <td>
                    <Button
                      onClick={() => {
                        setFiles(files.filter((_, j) => j !== i));
                        setPreview(undefined);
                      }}
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Field label="Snapshot name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. October campaign exports"
        />
      </Field>
      <Button
        primary
        busy={busy}
        disabled={!files.length || !asOf}
        onClick={() => run("preview")}
      >
        Validate and preview
      </Button>
      <ErrorBox error={error} />
      {preview && (
        <div className="import-preview">
          <h3>
            {preview.valid} of {preview.total} records valid
          </h3>
          <p className="muted">
            {preview.files
              .map((f: any) => `${f.name}: ${f.valid}/${f.total}`)
              .join(" · ")}
          </p>
          {preview.warnings?.length > 0 && (
            <div className="notice">
              {preview.warnings.map((w: string, i: number) => (
                <p key={i}>{w}</p>
              ))}
            </div>
          )}
          {preview.errors.length > 0 && (
            <div className="notice warning" role="alert">
              {preview.errors.slice(0, 12).map((e: any, i: number) => (
                <p key={i}>
                  {e.file}: row {e.row} — {e.message}
                </p>
              ))}
              {preview.errors.length > 12 && (
                <p>… and {preview.errors.length - 12} more</p>
              )}
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={acceptPartial}
                  onChange={(e) => setAcceptPartial(e.target.checked)}
                />{" "}
                Import the valid rows as an explicitly PARTIAL snapshot (invalid
                rows are quarantined and reports will say so)
              </label>
              {acceptPartial && (
                <Field label="Why is a partial snapshot acceptable?">
                  <input
                    value={partialReason}
                    onChange={(e) => setPartialReason(e.target.value)}
                  />
                </Field>
              )}
            </div>
          )}
          <details>
            <summary>Preview valid records</summary>
            <pre>{JSON.stringify(preview.records, null, 2)}</pre>
          </details>
          <Button
            primary
            busy={busy}
            disabled={
              !preview.valid ||
              (preview.errors.length > 0 && (!acceptPartial || !partialReason))
            }
            onClick={() => run("commit")}
          >
            Import {preview.valid} records
          </Button>
        </div>
      )}
    </Panel>
  );
}

function ReconcileForm({ id, onDone }: { id: string; onDone: () => void }) {
  const [level, setLevel] = useState("sample_reconciled"),
    [evidence, setEvidence] = useState(""),
    [error, setError] = useState<unknown>(null);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api("/connections/" + id + "/verification", {
            level,
            evidence,
          });
          onDone();
        } catch (err) {
          setError(err);
        }
      }}
    >
      <Field label="Verification level">
        <select value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="sample_reconciled">
            Sample reconciled against the native Oracle report
          </option>
          <option value="production_validated">Production validated</option>
        </select>
      </Field>
      <Field label="Evidence (filters, dates, counts compared, differences)">
        <textarea
          required
          minLength={20}
          rows={3}
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
        />
      </Field>
      <Button>Record evidence</Button>
      <ErrorBox error={error} />
    </form>
  );
}

function ConnectionForm({
  source,
  onDone,
}: {
  source: Source;
  onDone: () => void;
}) {
  const eloqua = source.app === "eloqua";
  const [baseUrl, setBaseUrl] = useState(
      eloqua ? "https://login.eloqua.com" : "",
    ),
    [auth, setAuth] = useState(
      eloqua
        ? "eloqua-basic"
        : source.app === "unity"
          ? "unity-password"
          : "bearer",
    ),
    [transport, setTransport] = useState(
      eloqua
        ? "eloqua-bulk"
        : source.app === "infinity"
          ? "infinity-export"
          : "rest",
    ),
    [tokenUrl, setTokenUrl] = useState(
      eloqua ? "https://login.eloqua.com/auth/oauth2/token" : "",
    ),
    [authorizationUrl, setAuthorizationUrl] = useState(
      eloqua ? "https://login.eloqua.com/auth/oauth2/authorize" : "",
    ),
    [scope, setScope] = useState(""),
    [exportUrl, setExportUrl] = useState(""),
    [activityTypes, setActivityTypes] = useState(
      "EmailSend,EmailOpen,EmailClickthrough,Bounceback,Unsubscribe,FormSubmit",
    ),
    [backfillDays, setBackfillDays] = useState(30),
    [timestampOffset, setTimestampOffset] = useState(""),
    [streamConfig, setStreamConfig] = useState(
      '{"streamUrl":"","streamMapping":{"id":"id","sessionId":"sessionId","event":"event","timestamp":"timestamp"},"streamItemsPath":"","streamWindowMinutes":60,"streamSnapshotSeconds":60}',
    ),
    [resources, setResources] = useState("[]"),
    [secrets, setSecrets] = useState<Record<string, string>>({}),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/sources/" + source.id + "/connections", {
        config: {
          baseUrl,
          auth,
          transport,
          tokenUrl,
          authorizationUrl,
          scope,
          exportUrl,
          ...(transport === "infinity-stream" ? JSON.parse(streamConfig) : {}),
          ...(transport === "eloqua-bulk"
            ? {
                activityTypes: activityTypes
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
                backfillDays,
                timestampOffset,
              }
            : {}),
          resources:
            transport === "rest" || transport === "infinity-export"
              ? JSON.parse(resources)
              : [],
          providerContractConfirmed: confirmed,
        },
        secrets,
      });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="connection-form">
      <h3>Configure an authorized source connection</h3>
      <p className="muted">
        Use the tenant's verified endpoints, grant and field mapping (see the{" "}
        {product(source.app).short} connector guide). Secrets are encrypted on
        the server and never shown again. Approved outbound hosts are set by the
        server administrator (OUTBOUND_HOSTS).
      </p>
      <form onSubmit={submit}>
        <div className="form-row">
          <Field
            label={
              eloqua
                ? "Eloqua login / discovery URL"
                : "Oracle instance base URL"
            }
          >
            <input
              required
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </Field>
          <Field label="Authentication">
            <select value={auth} onChange={(e) => setAuth(e.target.value)}>
              {eloqua && (
                <option value="eloqua-basic">
                  Eloqua basic (Company\User) — only if your policy permits
                </option>
              )}
              <option value="oauth">OAuth authorization code</option>
              <option value="bearer">Administrator-managed access token</option>
              {!eloqua && (
                <option value="basic">
                  Basic authentication (if documented)
                </option>
              )}
              {source.app === "unity" && (
                <option value="unity-password">
                  Unity documented password grant (IDCS)
                </option>
              )}
            </select>
          </Field>
        </div>
        {source.app === "infinity" && (
          <Field label="Data transport">
            <select
              value={transport}
              onChange={(e) => setTransport(e.target.value)}
            >
              <option value="infinity-export">
                Saved-report export (scheduled, not real time)
              </option>
              <option value="infinity-stream">
                Infinity Streams (JSON WebSocket)
              </option>
            </select>
          </Field>
        )}
        {transport === "eloqua-bulk" && (
          <div className="form-row">
            <Field label="Activity types (comma separated)">
              <input
                value={activityTypes}
                onChange={(e) => setActivityTypes(e.target.value)}
              />
            </Field>
            <Field
              label="Back-fill / look-back window (days)"
              hint="Each sync re-extracts this window and de-duplicates by activity ID to catch delayed activity."
            >
              <input
                type="number"
                min={1}
                max={90}
                value={backfillDays}
                onChange={(e) => setBackfillDays(Number(e.target.value))}
              />
            </Field>
            <Field
              label="Eloqua timestamp offset"
              hint="The UTC offset of your Eloqua instance's activity timestamps, e.g. -05:00. Required to interpret times."
            >
              <input
                placeholder="+00:00"
                pattern="[+-]\d{2}:\d{2}"
                value={timestampOffset}
                onChange={(e) => setTimestampOffset(e.target.value)}
              />
            </Field>
          </div>
        )}
        {transport === "infinity-export" && (
          <Field label="Generated saved-report export URL">
            <input
              required
              type="url"
              value={exportUrl}
              onChange={(e) => setExportUrl(e.target.value)}
            />
          </Field>
        )}
        {["oauth", "unity-password"].includes(auth) && (
          <>
            <Field label="Token URL">
              <input
                required
                type="url"
                value={tokenUrl}
                onChange={(e) => setTokenUrl(e.target.value)}
              />
            </Field>
            {auth === "oauth" && (
              <Field label="Authorization URL">
                <input
                  required
                  type="url"
                  value={authorizationUrl}
                  onChange={(e) => setAuthorizationUrl(e.target.value)}
                />
              </Field>
            )}
            <Field label="OAuth scope">
              <input value={scope} onChange={(e) => setScope(e.target.value)} />
            </Field>
          </>
        )}
        <SecretFields auth={auth} value={secrets} onChange={setSecrets} />
        {transport === "infinity-stream" && (
          <Field
            label="Verified stream contract (JSON)"
            hint="WSS endpoint, event mapping and subscription message from your Infinity administrator. Events before subscription are not replayed."
          >
            <textarea
              rows={8}
              className="code-input"
              value={streamConfig}
              onChange={(e) => setStreamConfig(e.target.value)}
            />
          </Field>
        )}
        {(transport === "rest" || transport === "infinity-export") && (
          <details open>
            <summary>Verified resource and field mapping (JSON)</summary>
            <p className="muted">
              Each resource: type ({ENTITY_TYPES[source.app].join(", ")}), path,
              itemsPath, pagination (none, offset, next) and a mapping from
              canonical fields to provider fields. No endpoints are pre-filled:
              use your tenant's documented contract.
            </p>
            <textarea
              className="code-input"
              rows={8}
              aria-label="Resource configuration JSON"
              value={resources}
              onChange={(e) => setResources(e.target.value)}
            />
          </details>
        )}
        <label className="checkbox">
          <input
            type="checkbox"
            required
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          I verified this source contract, its permissions and the records this
          workspace may access.
        </label>
        <Button primary busy={busy}>
          Save connection
        </Button>
        <ErrorBox error={error} />
      </form>
    </div>
  );
}
function SecretFields({
  auth,
  value,
  onChange,
}: {
  auth: string;
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
}) {
  const keys =
    auth === "eloqua-basic"
      ? ["siteName", "username", "password"]
      : auth === "basic"
        ? ["username", "password"]
        : auth === "bearer"
          ? ["accessToken"]
          : auth === "unity-password"
            ? ["clientId", "clientSecret", "username", "password"]
            : ["clientId", "clientSecret"];
  return (
    <div className="form-row">
      {keys.map((k) => (
        <Field
          key={k}
          label={
            k === "siteName"
              ? "Company (site) name"
              : k.replace(/([A-Z])/g, " $1")
          }
        >
          <input
            type={
              ["username", "clientId", "siteName"].includes(k)
                ? "text"
                : "password"
            }
            autoComplete="off"
            value={value[k] || ""}
            onChange={(e) => onChange({ ...value, [k]: e.target.value })}
          />
        </Field>
      ))}
    </div>
  );
}
function SecretRotation({
  connection,
  onDone,
}: {
  connection: any;
  onDone: () => void;
}) {
  const [secrets, setSecrets] = useState<Record<string, string>>({}),
    [error, setError] = useState<unknown>(null);
  return (
    <div>
      <SecretFields
        auth={connection.config.auth}
        value={secrets}
        onChange={setSecrets}
      />
      <Button
        onClick={async () => {
          try {
            await api("/connections/" + connection.id, { secrets }, "PATCH");
            setSecrets({});
            onDone();
          } catch (e) {
            setError(e);
          }
        }}
      >
        Save new credentials
      </Button>
      <ErrorBox error={error} />
    </div>
  );
}

export function SettingsPage({
  session,
  onDone,
}: {
  session: Session;
  onDone: () => Promise<void>;
}) {
  const [settings, setSettings] = useState<any>(),
    [name, setName] = useState(session.workspace?.name || ""),
    [logo, setLogo] = useState(session.workspace?.logo || ""),
    [email, setEmail] = useState(""),
    [role, setRole] = useState<Role>("analyst"),
    [apps, setApps] = useState<string[]>([]),
    [perms, setPerms] = useState<string[]>([]),
    [error, setError] = useState<unknown>(null),
    [saved, setSaved] = useState("");
  const load = async () => {
    setSettings(await api("/settings"));
  };
  useEffect(() => {
    load().catch(setError);
  }, []);
  if (session.workspace?.role !== "owner")
    return <Empty title="Administrator access required" />;
  return (
    <>
      <Panel
        title="Company branding and subscription"
        subtitle="Your platform provider manages which tools your company subscribes to. This platform does not verify Oracle licences."
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api("/settings", { name, logo: logo || null }, "PATCH");
              setSaved("Workspace settings saved.");
              await onDone();
            } catch (err) {
              setError(err);
            }
          }}
        >
          <div className="form-row">
            <Field label="Company name">
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Company logo URL (HTTPS)">
              <input
                type="url"
                value={logo}
                onChange={(e) => setLogo(e.target.value)}
                placeholder="https://company.example/logo.png"
              />
            </Field>
          </div>
          <div className="subscription-list" aria-label="Your subscription">
            <b>Your subscription</b>
            <ul>
              {PRODUCTS.map((p) => {
                const e = settings?.entitlements.find(
                  (x: any) => x.app === p.id && x.enabled,
                );
                return (
                  <li key={p.id} className={e ? "" : "muted"}>
                    {p.name}:{" "}
                    {e
                      ? "subscribed" +
                        (e.starts_at
                          ? ` from ${String(e.starts_at).slice(0, 10)}`
                          : "") +
                        (e.ends_at
                          ? ` until ${String(e.ends_at).slice(0, 10)}`
                          : "")
                      : "not subscribed"}
                  </li>
                );
              })}
            </ul>
            <small className="muted">
              To add or remove a tool, contact your platform provider.
            </small>
          </div>
          {settings?.entitlements.some(
            (x: any) => x.app === "responsys" && x.enabled,
          ) &&
            !settings?.responsysUrlConfigured && (
              <p className="muted">
                Responsys is in your subscription, but its address has not been
                set yet. Your platform provider sets it.
              </p>
            )}
          <Button primary>Save workspace settings</Button>
        </form>
        {saved && <div className="notice">{saved}</div>}
        <ErrorBox error={error} />
      </Panel>
      <Panel
        title="Workspace members"
        subtitle="Administrators manage members, sources and connections. Analysts work with granted data; connector administration and approvals are separate permissions. Viewers read only."
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api(
                "/members",
                {
                  email,
                  role,
                  apps,
                  permissions: role === "analyst" ? perms : [],
                },
                "PUT",
              );
              setEmail("");
              await load();
            } catch (err) {
              setError(err);
            }
          }}
        >
          <div className="form-row">
            <Field label="Member email">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Role">
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
              >
                <option value="viewer">Viewer</option>
                <option value="analyst">Analyst</option>
                <option value="owner">Administrator</option>
              </select>
            </Field>
            <Button primary>Add or update member</Button>
          </div>
          <fieldset>
            <legend>Application access for this member</legend>
            {PRODUCTS.map((p) => (
              <label className="checkbox" key={p.id}>
                <input
                  type="checkbox"
                  checked={apps.includes(p.id)}
                  onChange={(e) =>
                    setApps(
                      e.target.checked
                        ? [...apps, p.id]
                        : apps.filter((a) => a !== p.id),
                    )
                  }
                />
                {p.short}
              </label>
            ))}
          </fieldset>
          {role === "analyst" && (
            <fieldset>
              <legend>Additional permissions</legend>
              {[
                [
                  "connectors",
                  "Connector administration (configure, test and sync Oracle connections)",
                ],
                [
                  "approvals",
                  "Approvals (approve drafts and playbooks created by others)",
                ],
              ].map(([k, label]) => (
                <label className="checkbox" key={k}>
                  <input
                    type="checkbox"
                    checked={perms.includes(k)}
                    onChange={(e) =>
                      setPerms(
                        e.target.checked
                          ? [...perms, k]
                          : perms.filter((x) => x !== k),
                      )
                    }
                  />
                  {label}
                </label>
              ))}
            </fieldset>
          )}
        </form>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Applications</th>
                <th>Permissions</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {settings?.members.map((m: any) => (
                <tr key={m.id}>
                  <td>{m.email}</td>
                  <td>{ROLE_LABEL[m.role as Role]}</td>
                  <td>
                    {m.role === "owner"
                      ? "All enabled applications"
                      : m.apps.join(", ") || "None"}
                  </td>
                  <td>
                    {m.role === "owner"
                      ? "All"
                      : (m.permissions || []).join(", ") || "—"}
                  </td>
                  <td>
                    {m.id !== session.user.id && (
                      <Button
                        onClick={async () => {
                          if (!confirm("Remove this workspace membership?"))
                            return;
                          try {
                            await api("/members/" + m.id, {}, "DELETE");
                            await load();
                          } catch (e) {
                            setError(e);
                          }
                        }}
                      >
                        Remove
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
