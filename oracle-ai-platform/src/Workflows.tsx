import React, { useEffect, useState } from "react";
import {
  BellOff,
  Check,
  FileText,
  Microscope,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { api } from "./api";
import { Button, Panel, Field, ErrorBox, Empty, Guide, date } from "./ui";
import {
  product,
  type Report,
  type Session,
  type Source,
} from "../shared/catalog";

const writable = (s: Session) => s.workspace?.role !== "viewer";
function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T>(),
    [error, setError] = useState<unknown>(null);
  const reload = () => fn().then(setData).catch(setError);
  useEffect(() => {
    void reload();
  }, deps);
  return { data, error, setError, reload };
}
const Heading = ({
  eyebrow,
  title,
  text,
}: {
  eyebrow: string;
  title: string;
  text: string;
}) => (
  <div className="page-heading">
    <div>
      <span className="eyebrow">{eyebrow}</span>
      <h1>{title}</h1>
      <p>{text}</p>
    </div>
  </div>
);

export function ActionsPage({
  source,
  session,
}: {
  source: Source;
  session: Session;
}) {
  const {
    data: actions = [],
    error,
    setError,
    reload,
  } = useLoad<any[]>(
    () => api("/sources/" + source.id + "/actions"),
    [source.id],
  );
  const { data: value } = useLoad<any>(
    () => api("/sources/" + source.id + "/value"),
    [source.id],
  );
  const [title, setTitle] = useState(""),
    [detail, setDetail] = useState("");
  const w = writable(session);
  const patch = async (a: any, body: Record<string, unknown>) => {
    try {
      await api(
        "/actions/" + a.id,
        { state: a.state, version: a.version, ...body },
        "PATCH",
      );
      await reload();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <>
      <Heading
        eyebrow="FOLLOW THROUGH"
        title="Action plans"
        text="Internal follow-up from assessments. Outcomes compare the target rule and metric in newer snapshots; they are observations, not proof of cause."
      />
      <ErrorBox error={error} />
      {value && (
        <Panel title="Measured value" subtitle={value.timeSavedNote}>
          <p>
            Feedback:{" "}
            {value.feedback
              .map((f: any) => `${f.verdict} ${f.n}`)
              .join(" · ") || "none yet"}{" "}
            · issues no longer observed after an action:{" "}
            {value.issuesNoLongerObserved} · reports saved:{" "}
            {value.reports.saved} · AI answers: {value.ai.n} (
            {value.ai.fallback} rule-based fallbacks)
          </p>
        </Panel>
      )}
      <Panel title="Action plans">
        {w && (
          <form
            className="action-form"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api("/sources/" + source.id + "/actions", {
                  title,
                  detail,
                });
                setTitle("");
                setDetail("");
                await reload();
              } catch (err) {
                setError(err);
              }
            }}
          >
            <Field label="Action title">
              <input
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </Field>
            <Field label="Next step">
              <input
                required
                value={detail}
                onChange={(e) => setDetail(e.target.value)}
              />
            </Field>
            <Button primary>Save plan</Button>
          </form>
        )}
        {actions.length ? (
          actions.map((a) => (
            <article className="action-item" key={a.id}>
              <div>
                <h3>
                  {a.title} <span className="badge">{a.priority}</span>
                </h3>
                <p>{a.detail}</p>
                {a.baseline?.metric && (
                  <small className="muted">
                    Baseline {a.baseline.metric.id}:{" "}
                    {a.baseline.metric.value ?? "unavailable"} (as of{" "}
                    {date(a.baseline.asOf)})
                  </small>
                )}
                {a.outcome && (
                  <div
                    className={
                      "notice " +
                      (a.outcome.status === "issue_no_longer_observed"
                        ? ""
                        : "warning")
                    }
                  >
                    <b>{a.outcome.status.replaceAll("_", " ")}</b>
                    {a.outcome.metric &&
                      ` · ${a.outcome.metric.id}: ${a.outcome.metric.before ?? "—"} → ${a.outcome.metric.after ?? "—"}${a.outcome.metric.changePp ? ` (${a.outcome.metric.changePp} pp)` : ""}`}
                    . {a.outcome.statement} {a.outcome.flags.join(" ")}
                  </div>
                )}
                {a.report_id && (
                  <a
                    href={
                      "/api/reports/" + a.report_id + "/export?format=print"
                    }
                    target="_blank"
                    rel="noreferrer"
                  >
                    Evidence snapshot
                  </a>
                )}
              </div>
              <div className="form-row">
                <Field label="Status">
                  <select
                    disabled={!w}
                    value={a.state}
                    onChange={(e) => patch(a, { state: e.target.value })}
                  >
                    {[
                      "open",
                      "accepted",
                      "in_progress",
                      "dismissed",
                      "resolved",
                    ].map((s) => (
                      <option key={s} value={s}>
                        {s.replace("_", " ")}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Owner">
                  <input
                    disabled={!w}
                    defaultValue={a.assignee || ""}
                    onBlur={(e) =>
                      e.target.value !== (a.assignee || "") &&
                      patch(a, { assignee: e.target.value })
                    }
                  />
                </Field>
                <Field label="Due date">
                  <input
                    type="date"
                    disabled={!w}
                    defaultValue={a.due_date || ""}
                    onBlur={(e) =>
                      e.target.value !== (a.due_date || "") &&
                      patch(a, { dueDate: e.target.value || null })
                    }
                  />
                </Field>
                <Field label="Completion notes">
                  <input
                    disabled={!w}
                    defaultValue={a.completion_notes || ""}
                    onBlur={(e) =>
                      e.target.value !== (a.completion_notes || "") &&
                      patch(a, { completionNotes: e.target.value })
                    }
                  />
                </Field>
                {w && a.baseline && (
                  <Button
                    onClick={async () => {
                      try {
                        await api("/actions/" + a.id + "/evaluate", {});
                        await reload();
                      } catch (e) {
                        setError(e);
                      }
                    }}
                  >
                    <RefreshCw size={14} /> Check outcome
                  </Button>
                )}
              </div>
            </article>
          ))
        ) : (
          <Guide
            title="No action plans yet"
            what="An action plan turns a recommendation into tracked work with an owner, a due date and a before/after check of the measure it should move."
            steps={[
              "Open Summary and pick a recommendation.",
              "Click “Save plan” on it, or create an internal plan here.",
              "After your next data import, the plan shows whether the measure moved (an observation, not proof of cause).",
            ]}
          />
        )}
      </Panel>
    </>
  );
}

export function NotificationsPage({
  source,
  session,
}: {
  source: Source;
  session: Session;
}) {
  const {
    data: notes = [],
    error,
    setError,
    reload,
  } = useLoad<any[]>(
    () => api("/sources/" + source.id + "/notifications"),
    [source.id],
  );
  const op = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <>
      <Heading
        eyebrow="NOTIFICATIONS"
        title="Notifications"
        text="Internal alerts from syncs and scheduled digests, de-duplicated. Snoozed items return automatically."
      />
      <ErrorBox error={error} />
      <Panel
        title="Inbox"
        extra={
          <Button
            onClick={() =>
              op(() => api("/sources/" + source.id + "/notifications/read", {}))
            }
          >
            Mark all read
          </Button>
        }
      >
        {notes.length ? (
          notes.map((n) => (
            <div className={"notification severity-" + n.severity} key={n.id}>
              <span className={"dot " + (n.read_at ? "read" : "")} />
              <div>
                <p>
                  <span className="badge">{n.kind}</span> {n.message}
                </p>
                <small>
                  {date(n.created_at)}
                  {n.acknowledged_at ? " · acknowledged" : ""}
                </small>
                {n.report_id && (
                  <a
                    href={
                      "/api/reports/" + n.report_id + "/export?format=print"
                    }
                    target="_blank"
                    rel="noreferrer"
                  >
                    {" "}
                    Evidence
                  </a>
                )}
              </div>
              {writable(session) && (
                <span className="button-row">
                  {!n.acknowledged_at && (
                    <Button
                      onClick={() =>
                        op(() => api("/notifications/" + n.id + "/ack", {}))
                      }
                    >
                      <Check size={14} /> Acknowledge
                    </Button>
                  )}
                  <Button
                    onClick={() =>
                      op(() =>
                        api("/notifications/" + n.id + "/snooze", {
                          hours: 24,
                        }),
                      )
                    }
                  >
                    <BellOff size={14} /> Snooze 24 h
                  </Button>
                </span>
              )}
            </div>
          ))
        ) : (
          <Guide
            title="Nothing new"
            what="Notifications collect new high-priority findings, failed syncs and scheduled digests for this source."
            steps={[
              "Set a daily or weekly schedule under Data & connections → Scheduled assessment.",
              "New high-severity signals and failed connections then appear here.",
            ]}
          />
        )}
      </Panel>
    </>
  );
}

export function ReportsPage({
  source,
  report,
  session,
  notify,
}: {
  source: Source;
  report: Report | null;
  session: Session;
  notify: (s: string) => void;
}) {
  const [all, setAll] = useState(false);
  const {
    data: reports = [],
    error,
    setError,
    reload,
  } = useLoad<any[]>(
    () => api("/sources/" + source.id + "/reports" + (all ? "?all=1" : "")),
    [source.id, all],
  );
  const [title, setTitle] = useState("");
  return (
    <>
      <Heading
        eyebrow="REPORTS"
        title="Saved reports"
        text="Every report is an immutable evidence snapshot with its dataset, definitions and period. Exports: CSV/JSON data and a browser print view (save as PDF from your browser)."
      />
      <ErrorBox error={error} />
      {report && writable(session) && (
        <Panel title="Save the current assessment">
          <form
            className="form-row"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api("/reports/" + report.id + "/save", { title });
                setTitle("");
                notify("Report saved.");
                await reload();
              } catch (err) {
                setError(err);
              }
            }}
          >
            <Field label="Report title">
              <input
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. October review"
              />
            </Field>
            <Button primary>Save report</Button>
          </form>
        </Panel>
      )}
      <Panel
        title="Reports"
        extra={
          <label className="checkbox">
            <input
              type="checkbox"
              checked={all}
              onChange={(e) => setAll(e.target.checked)}
            />{" "}
            Include unsaved history
          </label>
        }
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Dataset</th>
                <th>Created</th>
                <th>Export</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.redacted_at ? (
                      <i>Deleted under retention policy</i>
                    ) : (
                      r.title || "Assessment view"
                    )}
                  </td>
                  <td>{r.dataset_name}</td>
                  <td>
                    {date(r.created_at)} · {r.created_by}
                  </td>
                  <td className="button-row">
                    {!r.redacted_at &&
                      ["print", "csv", "json"].map((f) => (
                        <a
                          key={f}
                          className="button"
                          href={"/api/reports/" + r.id + "/export?format=" + f}
                          target={f === "print" ? "_blank" : undefined}
                          rel="noreferrer"
                        >
                          {f === "print" ? "Print / PDF" : f.toUpperCase()}
                        </a>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!reports.length && (
            <Guide
              title="No saved reports yet"
              what="A saved report keeps an exact copy of an assessment (data snapshot, period and rules) so you can share it or compare later."
              steps={[
                "Open Summary, Analyze or Compare.",
                "Save the current view here with a title.",
                "Export it as CSV or JSON, or open the print view.",
              ]}
            />
          )}
        </div>
      </Panel>
    </>
  );
}

export function DraftsPage({
  source,
  report,
  session,
  start,
  onStarted,
}: {
  source: Source;
  report: Report | null;
  session: Session;
  start: { findingId?: string } | null;
  onStarted: () => void;
}) {
  const {
    data: drafts = [],
    error,
    setError,
    reload,
  } = useLoad<any[]>(
    () => api("/sources/" + source.id + "/drafts"),
    [source.id],
  );
  const { data: dict } = useLoad<any>(
    () => api("/dictionary/" + source.app),
    [source.app],
  );
  const [type, setType] = useState(""),
    [title, setTitle] = useState(""),
    [findingId, setFindingId] = useState(start?.findingId || ""),
    [useAI, setUseAI] = useState(true),
    [busy, setBusy] = useState(false),
    [openId, setOpenId] = useState<string | null>(null),
    [note, setNote] = useState("");
  useEffect(() => {
    if (start) {
      setFindingId(start.findingId || "");
      onStarted();
    }
  }, [start]);
  useEffect(() => {
    if (dict && !type) setType(dict.drafts[0]?.id || "");
  }, [dict]);
  const w = writable(session);
  return (
    <>
      <Heading
        eyebrow="DRAFT STUDIO"
        title="Drafts"
        text="Editable briefs, plans and copy prefilled from an assessment. A saved or approved draft is a platform record, not a native Oracle asset; nothing is published."
      />
      <ErrorBox error={error} />
      {w && report && dict && (
        <Panel title="New draft">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                const r = await api("/sources/" + source.id + "/drafts", {
                  draftType: type,
                  reportId: report.id,
                  findingId: findingId || undefined,
                  title,
                  useAI,
                });
                setNote(r.note);
                setTitle("");
                await reload();
                setOpenId(r.id);
              } catch (err) {
                setError(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="form-row">
              <Field label="Draft type">
                <select value={type} onChange={(e) => setType(e.target.value)}>
                  {dict.drafts.map((d: any) => (
                    <option key={d.id} value={d.id}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Based on finding">
                <select
                  value={findingId}
                  onChange={(e) => setFindingId(e.target.value)}
                >
                  <option value="">None / whole assessment</option>
                  {report.findings.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.title}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Draft title">
                <input
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Field>
            </div>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={useAI}
                onChange={(e) => setUseAI(e.target.checked)}
              />
              <Sparkles size={14} /> Draft with AI from evidence and approved
              playbooks (falls back to a labeled rule-based prefill)
            </label>
            <Button primary busy={busy}>
              <FileText size={15} /> Create draft
            </Button>
          </form>
          {note && <div className="notice">{note}</div>}
        </Panel>
      )}
      <Panel title="Drafts">
        {drafts.map((d) => (
          <DraftEditor
            key={d.id + d.version}
            d={d}
            session={session}
            dict={dict}
            open={openId === d.id}
            onToggle={() => setOpenId(openId === d.id ? null : d.id)}
            onChange={reload}
          />
        ))}
        {!drafts.length && (
          <Guide
            title="No drafts yet"
            what="Drafts are briefs, email copy, test plans or nurture outlines prepared from a recommendation, reviewed and approved here. Nothing is published to Oracle."
            steps={[
              "On a recommendation, click “Draft”, or choose a draft type here.",
              "Use “Write with AI” to prefill it from the evidence, then edit.",
              "Send it for review; a different person approves it.",
            ]}
          />
        )}
      </Panel>
    </>
  );
}
function DraftEditor({
  d,
  session,
  dict,
  open,
  onToggle,
  onChange,
}: {
  d: any;
  session: Session;
  dict: any;
  open: boolean;
  onToggle: () => void;
  onChange: () => void;
}) {
  const [content, setContent] = useState<Record<string, string>>(d.content),
    [revs, setRevs] = useState<any[]>([]),
    [error, setError] = useState<unknown>(null),
    [preview, setPreview] = useState<any>(null);
  const type = dict?.drafts.find((t: any) => t.id === d.draft_type);
  const w = writable(session),
    approver =
      session.workspace?.permissions?.includes("approvals") &&
      d.created_by !== session.user.id;
  const call = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <article className="draft">
      <button className="link" onClick={onToggle} aria-expanded={open}>
        <b>{d.title}</b> · {type?.label || d.draft_type} ·{" "}
        <span className="badge">{d.status.replace("_", " ")}</span> ·{" "}
        {d.generator === "ai"
          ? "AI draft"
          : d.generator === "rule_based"
            ? "Rule-based prefill"
            : "Manual"}{" "}
        · v{d.version} · {d.author}
        {d.reviewer ? ` · reviewed by ${d.reviewer}` : ""}
      </button>
      {open && type && (
        <div>
          {type.fields.map((f: any) => (
            <Field key={f.key} label={f.label}>
              {f.multiline ? (
                <textarea
                  rows={4}
                  disabled={!w}
                  value={content[f.key] || ""}
                  onChange={(e) =>
                    setContent({ ...content, [f.key]: e.target.value })
                  }
                />
              ) : (
                <input
                  disabled={!w}
                  value={content[f.key] || ""}
                  onChange={(e) =>
                    setContent({ ...content, [f.key]: e.target.value })
                  }
                />
              )}
            </Field>
          ))}
          {d.draft_type === "segment_definition" && (
            <div className="button-row">
              <Button
                onClick={async () => {
                  try {
                    const body =
                      content.definition &&
                      content.definition.trim() !==
                        '{"match":"all","conditions":[]}'
                        ? { definition: JSON.parse(content.definition) }
                        : { request: content.request };
                    const r = await api(
                      "/sources/" + d.source_id + "/audience/validate",
                      body,
                    );
                    setPreview(r);
                    if (r.ok)
                      setContent({
                        ...content,
                        definition: JSON.stringify(r.definition, null, 2),
                      });
                  } catch (e) {
                    setError(e);
                  }
                }}
              >
                Validate / translate request
              </Button>
              {preview && (
                <span className={preview.ok ? "notice" : "notice warning"}>
                  {preview.ok
                    ? `Valid (${preview.generator}). Local preview: ${preview.preview ? preview.preview.count + " members — " + preview.preview.basis : preview.previewNote}`
                    : preview.error}
                  {preview.unsupported?.length
                    ? ` Unsupported in this tenant: ${preview.unsupported.join(", ")}`
                    : ""}
                </span>
              )}
            </div>
          )}
          <div className="button-row">
            {w && (
              <Button
                onClick={() =>
                  call(() =>
                    api(
                      "/drafts/" + d.id,
                      { content, version: d.version, note: "Edited" },
                      "PATCH",
                    ),
                  )
                }
              >
                Save revision
              </Button>
            )}
            {w && d.status === "draft" && (
              <Button
                onClick={() =>
                  call(() =>
                    api("/drafts/" + d.id + "/status", {
                      status: "in_review",
                      version: d.version,
                    }),
                  )
                }
              >
                Submit for review
              </Button>
            )}
            {approver && d.status === "in_review" && (
              <>
                <Button
                  primary
                  onClick={() =>
                    call(() =>
                      api("/drafts/" + d.id + "/status", {
                        status: "approved",
                        version: d.version,
                      }),
                    )
                  }
                >
                  Approve
                </Button>
                <Button
                  onClick={() =>
                    call(() =>
                      api("/drafts/" + d.id + "/status", {
                        status: "rejected",
                        version: d.version,
                        note: prompt("Reason for rejection") || "Rejected",
                      }),
                    )
                  }
                >
                  Reject
                </Button>
              </>
            )}
            <Button
              onClick={async () =>
                setRevs(await api("/drafts/" + d.id + "/revisions"))
              }
            >
              Revision history
            </Button>
          </div>
          {revs.length > 0 && (
            <ul className="limitations">
              {revs.map((r) => (
                <li key={r.version}>
                  v{r.version} · {r.status} · {r.note} · {r.author} ·{" "}
                  {date(r.created_at)}
                </li>
              ))}
            </ul>
          )}
          <ErrorBox error={error} />
        </div>
      )}
    </article>
  );
}

export function InvestigationsPage({
  source,
  session,
  openId,
}: {
  source: Source;
  session: Session;
  openId: string | null;
}) {
  const {
    data: list = [],
    error,
    setError,
    reload,
  } = useLoad<any[]>(
    () => api("/sources/" + source.id + "/investigations"),
    [source.id],
  );
  const [current, setCurrent] = useState<string | null>(openId);
  const [inv, setInv] = useState<any>(null);
  const load = async (id: string) => {
    try {
      setInv(await api("/investigations/" + id));
    } catch (e) {
      setError(e);
    }
  };
  useEffect(() => {
    if (current) void load(current);
  }, [current]);
  const w = writable(session);
  const save = async (patch: Record<string, unknown>) => {
    try {
      await api(
        "/investigations/" + inv.id,
        { version: inv.version, ...patch },
        "PATCH",
      );
      await load(inv.id);
      await reload();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <>
      <Heading
        eyebrow="INVESTIGATION WORKSPACE"
        title="Investigations"
        text="Assemble the timeline, metrics, lineage and missing evidence for a finding. Hypotheses stay separate from confirmed observations and can be continued by colleagues."
      />
      <ErrorBox error={error} />
      <Panel title="Open investigations">
        {list.map((i) => (
          <button
            key={i.id}
            className={"link list-item " + (current === i.id ? "active" : "")}
            onClick={() => setCurrent(i.id)}
          >
            <Microscope size={14} /> {i.title} · {i.status} ·{" "}
            {date(i.updated_at)} · {i.created_by}
          </button>
        ))}
        {!list.length && (
          <Guide
            title="No investigations yet"
            what="An investigation collects the evidence, timeline, possible explanations (labelled as hypotheses) and checks for one finding."
            steps={[
              "On a recommendation, click “Investigate”.",
              "Add notes and tick off checks as you confirm or rule out each explanation.",
            ]}
          />
        )}
      </Panel>
      {inv && (
        <>
          <Panel
            title={inv.title}
            subtitle={`Rule ${inv.finding.rule} · ${inv.finding.severity}`}
          >
            <p>
              <b>Observed:</b> {inv.finding.detail}
            </p>
            <h3>Timeline across snapshots</h3>
            <ul className="limitations">
              {inv.timeline.map((t: any) => (
                <li key={t.id}>
                  {date(t.as_of)} · {t.dataset} —{" "}
                  {t.present ? "rule triggered" : "not observed"}
                </li>
              ))}
            </ul>
            <h3>Supporting metrics</h3>
            <ul className="limitations">
              {inv.metrics.map((m: any) => (
                <li key={m.id}>
                  {m.label}: {m.value ?? "unavailable"} — {m.formula}
                </li>
              ))}
              {!inv.metrics.length && (
                <li>Record-level finding; see the records in the evidence.</li>
              )}
            </ul>
            <details>
              <summary>Source lineage</summary>
              <pre>{JSON.stringify(inv.lineage, null, 2)}</pre>
            </details>
            <h3>Related findings</h3>
            <ul className="limitations">
              {inv.related.map((f: any) => (
                <li key={f.id}>{f.title}</li>
              ))}
              {!inv.related.length && <li>None in this snapshot.</li>}
            </ul>
            <h3>Missing evidence</h3>
            <ul className="limitations">
              {inv.missingEvidence.map((m: string, i: number) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </Panel>
          <Panel
            title="Hypotheses (not proven)"
            extra={
              w ? (
                <Button
                  onClick={async () => {
                    try {
                      const r = await api(
                        "/investigations/" + inv.id + "/hypotheses",
                        {},
                      );
                      if (r.note) alert(r.note);
                      await load(inv.id);
                    } catch (e) {
                      setError(e);
                    }
                  }}
                >
                  <Sparkles size={14} /> Suggest with AI
                </Button>
              ) : undefined
            }
          >
            {inv.hypotheses.map((h: any, i: number) => (
              <div className="inline-item" key={i}>
                <span>
                  <span className="badge">{h.source}</span> {h.text}{" "}
                  {h.test && <small className="muted">Test: {h.test}</small>}
                </span>
                <select
                  disabled={!w}
                  value={h.status}
                  aria-label="Hypothesis status"
                  onChange={(e) =>
                    save({
                      hypotheses: inv.hypotheses.map((x: any, j: number) =>
                        j === i ? { ...x, status: e.target.value } : x,
                      ),
                    })
                  }
                >
                  <option value="open">open</option>
                  <option value="supported">supported by evidence</option>
                  <option value="rejected">rejected</option>
                </select>
              </div>
            ))}
            {w && (
              <form
                className="form-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  const text = (
                    e.currentTarget.elements.namedItem("h") as HTMLInputElement
                  ).value;
                  void save({
                    hypotheses: [
                      ...inv.hypotheses,
                      { text, status: "open", source: "user" },
                    ],
                  });
                  e.currentTarget.reset();
                }}
              >
                <Field label="Add a hypothesis">
                  <input name="h" required />
                </Field>
                <Button>Add</Button>
              </form>
            )}
          </Panel>
          <Panel title="Next checks">
            {inv.checks.map((c: any, i: number) => (
              <label className="checkbox" key={i}>
                <input
                  type="checkbox"
                  disabled={!w}
                  checked={c.done}
                  onChange={(e) =>
                    save({
                      checks: inv.checks.map((x: any, j: number) =>
                        j === i ? { ...x, done: e.target.checked } : x,
                      ),
                    })
                  }
                />
                {c.text}
              </label>
            ))}
            <Field label="Notes">
              <textarea
                rows={4}
                disabled={!w}
                defaultValue={inv.notes}
                onBlur={(e) =>
                  e.target.value !== inv.notes &&
                  save({ notes: e.target.value })
                }
              />
            </Field>
            {w && (
              <Button
                onClick={() =>
                  save({ status: inv.status === "open" ? "closed" : "open" })
                }
              >
                {inv.status === "open" ? "Close investigation" : "Reopen"}
              </Button>
            )}
          </Panel>
        </>
      )}
    </>
  );
}

export function CrossAppPage({ session }: { session: Session }) {
  const { data: sources = [] } = useLoad<any[]>(
    () => api("/cross/sources"),
    [],
  );
  const {
    data: mappings = [],
    error,
    setError,
    reload,
  } = useLoad<any[]>(() => api("/cross/mappings"), []);
  const [form, setForm] = useState({
    name: "",
    leftSource: "",
    leftEntity: "",
    leftField: "",
    rightSource: "",
    rightEntity: "",
    rightField: "",
    normalization: "lowercase-trim",
  });
  const [result, setResult] = useState<any>(null);
  const admin = session.workspace?.role === "owner";
  const apps = new Set(sources.map((s) => s.app));
  const ent: Record<string, string[]> = {
    eloqua: ["contact", "activity", "campaign"],
    unity: ["profile", "membership"],
    infinity: ["event"],
  };
  const srcApp = (id: string) => sources.find((s) => s.id === id)?.app;
  return (
    <main className="workspace-content">
      <Heading
        eyebrow="CROSS-APPLICATION EVIDENCE"
        title="Combined evidence"
        text="Investigate across Eloqua, Unity and Infinity only through an administrator-approved identifier mapping. Join coverage is shown; no person-level linkage or causal attribution is implied."
      />
      <ErrorBox error={error} />
      {apps.size < 2 ? (
        <Empty title="Needs two authorized applications">
          You need access to sources in at least two of Eloqua, Unity and
          Infinity. Without an approved mapping, findings stay separate per
          application.
        </Empty>
      ) : (
        <>
          {admin && (
            <Panel
              title="Approve an identifier mapping"
              subtitle="Example: Eloqua contact email domain ↔ Unity profile field, or Eloqua campaign ID ↔ Infinity event campaign code."
            >
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  try {
                    await api("/cross/mappings", form);
                    await reload();
                  } catch (err) {
                    setError(err);
                  }
                }}
              >
                <Field label="Mapping name">
                  <input
                    required
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </Field>
                {(["left", "right"] as const).map((side) => (
                  <div className="form-row" key={side}>
                    <Field
                      label={side === "left" ? "First source" : "Second source"}
                    >
                      <select
                        required
                        value={(form as any)[side + "Source"]}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            [side + "Source"]: e.target.value,
                            [side + "Entity"]: "",
                          })
                        }
                      >
                        <option value="">Choose…</option>
                        {sources.map((s) => (
                          <option key={s.id} value={s.id}>
                            {product(s.app).short} · {s.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Entity">
                      <select
                        required
                        value={(form as any)[side + "Entity"]}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            [side + "Entity"]: e.target.value,
                          })
                        }
                      >
                        <option value="">Choose…</option>
                        {(
                          ent[srcApp((form as any)[side + "Source"]) || ""] ||
                          []
                        ).map((x) => (
                          <option key={x}>{x}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Identifier field">
                      <input
                        required
                        pattern="[a-zA-Z][a-zA-Z0-9_]*"
                        value={(form as any)[side + "Field"]}
                        onChange={(e) =>
                          setForm({ ...form, [side + "Field"]: e.target.value })
                        }
                      />
                    </Field>
                  </div>
                ))}
                <Field label="Normalization">
                  <select
                    value={form.normalization}
                    onChange={(e) =>
                      setForm({ ...form, normalization: e.target.value })
                    }
                  >
                    <option value="lowercase-trim">Lower-case and trim</option>
                    <option value="exact">Exact</option>
                  </select>
                </Field>
                <Button primary>Approve mapping</Button>
              </form>
            </Panel>
          )}
          <Panel title="Approved mappings">
            {mappings.map((m) => (
              <div className="inline-item" key={m.id}>
                <span>
                  {m.name}: {m.left_entity}.{m.left_field} ↔ {m.right_entity}.
                  {m.right_field} ({m.normalization})
                </span>
                <Button
                  onClick={async () => {
                    try {
                      setResult(
                        await api("/cross/mappings/" + m.id + "/assess", {}),
                      );
                    } catch (e) {
                      setError(e);
                    }
                  }}
                >
                  Assess combined evidence
                </Button>
              </div>
            ))}
            {!mappings.length && (
              <p className="muted">No approved mappings you can access.</p>
            )}
          </Panel>
          {result && (
            <Panel title={"Combined evidence · " + result.mapping.name}>
              <p>
                <b>Join coverage:</b> {result.joinCoverage.matched} matched
                identifiers · {result.joinCoverage.leftMatchedPct ?? "—"}% of{" "}
                {result.joinCoverage.leftKeys} on the first side ·{" "}
                {result.joinCoverage.rightMatchedPct ?? "—"}% of{" "}
                {result.joinCoverage.rightKeys} on the second side.
              </p>
              <div className="two-column">
                {[result.left, result.right].map((side: any) => (
                  <div key={side.sourceId}>
                    <h3>
                      {product(side.app).short} · {side.name}
                    </h3>
                    <small className="muted">
                      Data as of {date(side.asOf)}
                    </small>
                    <ul className="limitations">
                      {side.findings.map((f: any) => (
                        <li key={f.id}>
                          <b>{f.title}</b> — {f.detail}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
              <ul className="limitations">
                {result.caveats.map((c: string, i: number) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </Panel>
          )}
        </>
      )}
    </main>
  );
}
