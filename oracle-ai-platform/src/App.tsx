import React, { useEffect, useState, useCallback } from "react";
import { BrandLogos } from "./Brand";
import {
  ArrowRight,
  Bell,
  Building2,
  ChartNoAxesCombined,
  ClipboardList,
  Database,
  FileStack,
  FileText,
  FlaskConical,
  Layers,
  LogOut,
  MessageSquare,
  PenTool,
  Microscope,
  Network,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  Sparkles,
} from "lucide-react";
import { api, setCsrf } from "./api";
import { Button, Field, ErrorBox, Empty, Loading, Panel } from "./ui";
import {
  PRODUCTS,
  TOPICS,
  ROLE_LABEL,
  product,
  isApp,
  type AppId,
  type ProductId,
  type Session,
  type Source,
  type Report,
  type Tab,
  type Finding,
} from "../shared/catalog";
import {
  AssessmentBody,
  Analyze,
  Compare,
  Simulator,
  Chat,
  ContextHeader,
  type FindingHandlers,
} from "./Views";
import { DataPage, NewSource, SettingsPage } from "./DataAdmin";
import { StudioTab, BUILDER_LABEL } from "./Studio";
import { ResponsysFrame } from "./Responsys";
import {
  ActionsPage,
  NotificationsPage,
  ReportsPage,
  DraftsPage,
  InvestigationsPage,
  CrossAppPage,
} from "./Workflows";
import { Login, Setup, Home, pendingCompany, type Intent } from "./Home";
import { ProviderConsole } from "./Provider";

// Responsys single sign-on sends signed-out users here with ?next=/sso/authorize?...; continue
// that sign-in after the platform sign-in. Only that exact same-origin path is accepted.
const NEXT_KEY = "oap.next";
try {
  const next = new URLSearchParams(location.search).get("next");
  if (next && next.startsWith("/sso/authorize?")) {
    sessionStorage.setItem(NEXT_KEY, next);
    history.replaceState(null, "", location.pathname);
  }
} catch {
  /* storage unavailable: the user can open Responsys again from the home page */
}
const takeNext = () => {
  try {
    const v = sessionStorage.getItem(NEXT_KEY);
    sessionStorage.removeItem(NEXT_KEY);
    return v;
  } catch {
    return null;
  }
};

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(),
    [app, setApp] = useState<ProductId | "cross" | null>(null),
    [intent, setIntent] = useState<Intent>({}),
    [provider, setProvider] = useState(false),
    [error, setError] = useState<unknown>(null);
  const reload = useCallback(async () => {
    try {
      let s = await api<Session | null>("/session");
      setCsrf(s?.csrf || "");
      // Open the company chosen on the sign-in page, if this user is a member of it.
      const wanted = pendingCompany.get();
      if (s && wanted) {
        pendingCompany.clear();
        const w = s.workspaces.find((x) => x.slug === wanted);
        if (w && w.id !== s.workspace?.id) {
          await api("/session/workspace", { id: w.id });
          s = await api<Session | null>("/session");
        } else if (!w)
          setError(
            Error(
              `You are not a member of the company “${wanted}”. Showing your other workspaces.`,
            ),
          );
      }
      if (s?.workspace) {
        const next = takeNext();
        if (next) {
          location.assign(next);
          return;
        }
      }
      setSession(s);
      setApp((a) =>
        a && (a === "cross" || s?.products.includes(a)) ? a : null,
      );
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  const choose = async (id: ProductId | "cross", next: Intent = {}) => {
    setError(null);
    setIntent(next);
    if (id === "responsys") {
      try {
        // Checks the subscription and that v17 is running (the reason is shown if not).
        const r = await api("/responsys");
        // Behind this platform, Responsys opens inside the platform window like the other
        // tools; otherwise in this window at the company's Responsys address.
        if (session?.responsysEmbedded) setApp("responsys");
        else window.location.assign(r.url);
      } catch (e) {
        setError(e);
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    } else setApp(id);
  };
  if (session === undefined)
    return (
      <>
        <Loading />
        <ErrorBox error={error} />
      </>
    );
  if (!session) return <Login onDone={reload} />;
  const openCompany = async (wid: string) => {
    await api("/session/workspace", { id: wid });
    setProvider(false);
    setApp(null);
    await reload();
  };
  if (!session.workspace && !(session.provider && provider))
    return (
      <>
        {session.provider && session.workspaces.length > 0 && (
          <div className="workspace-content">
            <Button onClick={() => setProvider(true)}>
              <Building2 size={16} /> Client companies and subscriptions
            </Button>
          </div>
        )}
        <Setup session={session} onDone={reload} />
      </>
    );
  if (!session.workspace)
    return (
      <ProviderConsole
        email={session.user.email}
        onChanged={reload}
        onOpen={openCompany}
      />
    );
  return (
    <>
      <header className="topbar">
        <button
          className="brand link"
          onClick={() => {
            setApp(null);
            setProvider(false);
            setIntent({});
          }}
          aria-label="Company home"
        >
          <BrandLogos brand={session.workspace.brand} fallback={session.workspace.logo} />
          <div>
            <strong>{session.workspace.brand?.displayName || session.workspace.name}</strong>
            <small>Oracle AI Assessment Platform</small>
          </div>
        </button>
        <div className="top-actions">
          {session.provider && (
            <Button
              onClick={() => {
                setApp(null);
                setProvider(!provider);
              }}
            >
              <Building2 size={16} />{" "}
              {provider ? "Company home" : "Provider console"}
            </Button>
          )}
          <select
            aria-label="Workspace"
            value={session.workspace.id}
            onChange={async (e) => {
              await api("/session/workspace", { id: e.target.value });
              setApp(null);
              setProvider(false);
              await reload();
            }}
          >
            {session.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <span className="identity">
            {session.user.email}
            <small>{ROLE_LABEL[session.workspace.role]}</small>
          </span>
          <button
            className="icon-button"
            aria-label="Sign out"
            onClick={async () => {
              await api("/auth/logout", {});
              setApp(null);
              await reload();
            }}
          >
            <LogOut size={18} />
          </button>
        </div>
      </header>
      {session.mode === "dev" && (
        <div className="dev-banner">
          Local development sign-in · production requires your organization's
          single sign-on
        </div>
      )}
      <ErrorBox error={error} />
      {session.workspace.status === "suspended" && (
        <div className="error" role="alert">
          This company's subscription is suspended. Contact your platform
          provider.
        </div>
      )}
      {provider && session.provider ? (
        <ProviderConsole
          email={session.user.email}
          onChanged={reload}
          onOpen={openCompany}
        />
      ) : app === "cross" ? (
        <CrossAppPage session={session} />
      ) : app === "responsys" ? (
        <ResponsysFrame
          key={session.workspace.id}
          session={session}
          onSwitch={choose}
        />
      ) : app && isApp(app) ? (
        <Application
          key={session.workspace.id + app + JSON.stringify(intent)}
          app={app}
          intent={intent}
          session={session}
          onSwitch={choose}
          onSettingsChange={reload}
        />
      ) : (
        <Home
          session={session}
          onChoose={choose}
          onSettingsChange={reload}
          onProvider={() => setProvider(true)}
        />
      )}
    </>
  );
}
function Application({
  app,
  intent = {},
  session,
  onSwitch,
  onSettingsChange,
}: {
  app: AppId;
  intent?: Intent;
  session: Session;
  onSwitch: (id: ProductId) => void;
  onSettingsChange: () => Promise<void>;
}) {
  const [sources, setSources] = useState<Source[]>([]),
    [sourceId, setSourceId] = useState(""),
    [tab, setTab] = useState<Tab>(intent.tab || "summary"),
    [lastFollowUp, setLastFollowUp] = useState<Tab>("actions"),
    [datasets, setDatasets] = useState<any[]>([]),
    [datasetId, setDatasetId] = useState(""),
    [report, setReport] = useState<Report | null>(null),
    [error, setError] = useState<unknown>(null),
    [loading, setLoading] = useState(false),
    [epoch, setEpoch] = useState(0),
    [newSource, setNewSource] = useState(false),
    [notice, setNotice] = useState(""),
    [periodStart, setPeriodStart] = useState(""),
    [periodEnd, setPeriodEnd] = useState(""),
    [draftStart, setDraftStart] = useState<{ findingId?: string } | null>(null),
    [askQuestion, setAskQuestion] = useState<{ q: string; n: number } | null>(
      null,
    ),
    [investigation, setInvestigation] = useState<string | null>(null),
    [studioKey, setStudioKey] = useState("");
  const p = product(app),
    source = sources.find((s) => s.id === sourceId);
  const reload = () => setEpoch((e) => e + 1);
  const notify = (s: string) => {
    setNotice(s);
    setTimeout(() => setNotice(""), 6000);
  };
  // "Follow-up" reopens the follow-up page used last.
  useEffect(() => {
    if (["actions", "drafts", "investigations", "reports"].includes(tab))
      setLastFollowUp(tab);
  }, [tab]);
  useEffect(() => {
    const c = new AbortController();
    api<Source[]>("/sources?app=" + app, undefined, undefined, c.signal)
      .then((rows) => {
        setSources(rows);
        setSourceId((old) =>
          !old && intent.sourceId && rows.some((r) => r.id === intent.sourceId)
            ? intent.sourceId
            : rows.some((r) => r.id === old)
              ? old
              : rows[0]?.id || "",
        );
      })
      .catch((e) => e.name !== "AbortError" && setError(e));
    return () => c.abort();
  }, [app, epoch]);
  // Switching source resets every source-scoped selection (datasets, report, chat, drafts…).
  useEffect(() => {
    setReport(null);
    setDatasets([]);
    setDatasetId("");
    setError(null);
    setDraftStart(null);
    setInvestigation(null);
    if (!sourceId) return;
    const c = new AbortController();
    api<any[]>(
      "/sources/" + sourceId + "/datasets",
      undefined,
      undefined,
      c.signal,
    )
      .then((rows) => {
        setDatasets(rows.filter((d) => !d.redacted_at));
        setDatasetId(rows.find((r) => r.active)?.id || "");
      })
      .catch((e) => e.name !== "AbortError" && setError(e));
    return () => c.abort();
  }, [sourceId, epoch]);
  useEffect(() => {
    setReport(null);
    setError(null);
    if (!sourceId || !datasetId) return;
    const c = new AbortController();
    setLoading(true);
    api<Report>(
      "/sources/" + sourceId + "/reports",
      {
        datasetId,
        periodStart: periodStart || undefined,
        periodEnd: periodEnd || undefined,
      },
      "POST",
      c.signal,
    )
      .then(setReport)
      .catch((e) => e.name !== "AbortError" && setError(e))
      .finally(() => !c.signal.aborted && setLoading(false));
    return () => c.abort();
  }, [sourceId, datasetId, periodStart, periodEnd]);
  const canWrite = session.workspace?.role !== "viewer";
  const handlers: FindingHandlers = {
    canWrite,
    onAsk: (q: string) => {
      setAskQuestion((x) => ({ q, n: (x?.n || 0) + 1 }));
      setTab("chat");
    },
    onUpload: () => setTab("data"),
    onAction: async (f: Finding) => {
      try {
        await api("/sources/" + sourceId + "/actions", {
          title: f.title,
          detail: f.action,
          reportId: report!.id,
          findingId: f.id,
          priority:
            f.severity === "high"
              ? "high"
              : f.severity === "low" || f.severity === "info"
                ? "low"
                : "medium",
        });
        notify(
          "Action plan saved with an evidence baseline. Track it under Action plans.",
        );
      } catch (e) {
        setError(e);
      }
    },
    onInvestigate: async (f: Finding) => {
      try {
        const r = await api("/sources/" + sourceId + "/investigations", {
          reportId: report!.id,
          findingId: f.id,
        });
        setInvestigation(r.id);
        setTab("investigations");
      } catch (e) {
        setError(e);
      }
    },
    onDraft: (f: Finding) => {
      setDraftStart({ findingId: f.id });
      setTab("drafts");
    },
    onFeedback: async (f: Finding, verdict) => {
      const reason =
        verdict === "dismissed"
          ? prompt("Why is this recommendation not useful?")
          : "";
      if (verdict === "dismissed" && !reason) return;
      try {
        await api("/reports/" + report!.id + "/feedback", {
          findingId: f.id,
          verdict,
          reason: reason || "",
        });
        notify(
          verdict === "useful"
            ? "Thanks — marked useful."
            : "Dismissed with your reason.",
        );
      } catch (e) {
        setError(e);
      }
    },
  };
  const tabs: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: "summary", label: "Summary", icon: ChartNoAxesCombined },
    { id: "simulator", label: "AI Simulator", icon: FlaskConical },
    { id: "analyze", label: p.analyze, icon: Search },
    { id: "compare", label: p.compare, icon: Layers },
    { id: "builder", label: BUILDER_LABEL[app] || "Builder", icon: PenTool },
    { id: "chat", label: p.ask, icon: MessageSquare },
  ];
  // Work created from recommendations is grouped under one "Follow-up" button.
  const followUp: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: "actions", label: "Action plans", icon: ClipboardList },
    { id: "drafts", label: "Drafts", icon: FileText },
    { id: "investigations", label: "Investigations", icon: Microscope },
    { id: "reports", label: "Reports", icon: FileStack },
  ];
  const inFollowUp = followUp.some((t) => t.id === tab);
  const secondary: {
    id: Tab;
    label: string;
    icon: React.ElementType;
    active: boolean;
  }[] = [
    {
      id: "data",
      label: "Data & connections",
      icon: Database,
      active: tab === "data",
    },
    {
      id: lastFollowUp,
      label: "Follow-up",
      icon: ClipboardList,
      active: inFollowUp,
    },
    {
      id: "notifications",
      label: "Notifications",
      icon: Bell,
      active: tab === "notifications",
    },
  ];
  const needsReport = [
    "summary",
    "analyze",
    "compare",
    "simulator",
    "chat",
    "builder",
  ].includes(tab);
  return (
    <>
      <div className="application-nav">
        <div className="app-picker">
          <select
            aria-label="Application"
            value={app}
            onChange={(e) => onSwitch(e.target.value as ProductId)}
          >
            {session.products.map((id) => (
              <option key={id} value={id}>
                {product(id).name}
              </option>
            ))}
          </select>
        </div>
        <nav aria-label="Main">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? "active" : ""}
              aria-current={tab === t.id ? "page" : undefined}
              onClick={() => setTab(t.id)}
            >
              <t.icon size={16} />
              {t.label}
            </button>
          ))}
        </nav>
      </div>
      {session.workspace?.brand?.guardrails?.length || session.workspace?.brand?.displayName ? (
        <div className="client-strip" aria-label="Client context">
          <b>{session.workspace.brand?.displayName || session.workspace.name}</b>
          {session.workspace.brand?.sector === "liquor_retail" && <span>Liquor retail</span>}
          {session.workspace.brand?.guardrails?.length ? (
            <span title={session.workspace.brand.guardrails.join("\n")}>
              AI follows {session.workspace.brand.guardrails.length} client marketing rule(s): {session.workspace.brand.guardrails[0]}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="contextbar">
        <div className="source-pickers">
          <Field label="Source account / environment">
            <select
              aria-label="Source account"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
            >
              <option value="">Choose a source</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.environment || "production"}
                </option>
              ))}
            </select>
          </Field>
          {datasets.length > 0 && (
            <Field label="Data snapshot">
              <select
                aria-label="Data snapshot"
                value={datasetId}
                onChange={(e) => setDatasetId(e.target.value)}
              >
                {datasets.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                    {d.active ? " · active" : ""}
                    {d.metadata?.completeness === "partial" ? " · partial" : ""}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        <nav className="context-actions" aria-label="Workspace tools">
          {secondary.map((t) => (
            <Button
              key={t.label}
              className={t.active ? "active" : ""}
              aria-current={t.active ? "page" : undefined}
              onClick={() => setTab(t.id)}
            >
              <t.icon size={15} /> {t.label}
            </Button>
          ))}
          {session.workspace?.role === "owner" && (
            <Button onClick={() => setTab("settings")} aria-label="Settings">
              <SettingsIcon size={16} />
            </Button>
          )}
        </nav>
      </div>
      <main className="workspace-content">
        {inFollowUp && (
          <nav className="sub-tabs" aria-label="Follow-up">
            {followUp.map((t) => (
              <button
                key={t.id}
                className={tab === t.id ? "active" : ""}
                aria-current={tab === t.id ? "page" : undefined}
                onClick={() => setTab(t.id)}
              >
                <t.icon size={15} /> {t.label}
              </button>
            ))}
          </nav>
        )}
        {source && ["summary", "analyze", "compare"].includes(tab) && (
          <div className="period-filter">
            <Field label="Period start">
              <input
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
              />
            </Field>
            <Field label="Period end">
              <input
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
              />
            </Field>
            <small>
              Dates use {source.timezone}. Aggregate rows are included only when
              their whole period falls inside the range; snapshot measures
              (profiles, structure) ignore the period.
            </small>
          </div>
        )}
        {notice && (
          <div className="notice" role="status">
            {notice}
          </div>
        )}
        <ErrorBox error={error} />
        {tab === "settings" ? (
          <SettingsPage session={session} onDone={onSettingsChange} />
        ) : !source ? (
          <>
            <Empty
              title={`Add your first ${p.short} source account`}
              action={
                session.workspace?.role === "owner" ? (
                  <Button primary onClick={() => setNewSource(true)}>
                    Add source account
                  </Button>
                ) : undefined
              }
            >
              {session.workspace?.role === "owner"
                ? `Create a source account for an authorized ${p.short} instance, then upload exports or connect it. Your workspace starts empty.`
                : "No source account is shared with you yet. Ask your administrator for access."}
            </Empty>
            {newSource && (
              <NewSource
                app={app}
                onDone={() => {
                  setNewSource(false);
                  reload();
                }}
              />
            )}
          </>
        ) : tab === "data" ? (
          <DataPage
            key={source.id}
            source={source}
            session={session}
            onDone={reload}
            notify={notify}
          />
        ) : tab === "actions" ? (
          <ActionsPage key={source.id} source={source} session={session} />
        ) : tab === "notifications" ? (
          <NotificationsPage
            key={source.id}
            source={source}
            session={session}
          />
        ) : tab === "reports" ? (
          <ReportsPage
            key={source.id}
            source={source}
            report={report}
            session={session}
            notify={notify}
          />
        ) : tab === "drafts" ? (
          <DraftsPage
            key={source.id}
            source={source}
            report={report}
            session={session}
            start={draftStart}
            onStarted={() => setDraftStart(null)}
          />
        ) : tab === "investigations" ? (
          <InvestigationsPage
            key={source.id + (investigation || "")}
            source={source}
            session={session}
            openId={investigation}
          />
        ) : loading ? (
          <Loading />
        ) : !report && needsReport ? (
          <div className="no-data">
            <Empty
              title="Your assessment starts with data"
              action={
                <div className="button-row center">
                  {session.mode === "dev" && canWrite && (
                    <Button
                      primary
                      onClick={async () => {
                        try {
                          const r = await api(
                            "/sources/" + source.id + "/examples/load",
                            {},
                          );
                          notify(
                            `Loaded ${r.records} sample records (synthetic data). Replace them with your own exports any time.`,
                          );
                          reload();
                        } catch (e) {
                          setError(e);
                        }
                      }}
                    >
                      <Sparkles size={16} /> Load sample data
                    </Button>
                  )}
                  <Button onClick={() => setTab("data")}>
                    Upload my exports <ArrowRight size={16} />
                  </Button>
                </div>
              }
            >
              Upload your {p.short} exports, connect your instance, or load
              clearly labelled sample data to explore every page first.
            </Empty>
            <div className="topic-preview">
              {TOPICS[app].map((t) => (
                <div key={t.name}>
                  <b>{t.name}</b>
                  <p>{t.shows}</p>
                  <small>Needs: {t.needs}</small>
                </div>
              ))}
            </div>
          </div>
        ) : report ? (
          <>
            <div className="page-heading">
              <div>
                <span className="eyebrow">
                  {p.short.toUpperCase()} INTELLIGENCE
                </span>
                <h1>
                  {tab === "summary"
                    ? p.summary
                    : tabs.find((t) => t.id === tab)?.label}
                </h1>
              </div>
              <Button onClick={reload}>
                <RefreshCw size={15} /> Refresh assessment
              </Button>
            </div>
            <ContextHeader report={report} source={source} />
            {tab === "summary" && (
              <AssessmentBody key={report.id} report={report} h={handlers} />
            )}
            {tab === "analyze" && (
              <>
                <StudioTab
                  view="analyze"
                  source={source}
                  report={report}
                  periodStart={periodStart}
                  periodEnd={periodEnd}
                  selected={studioKey}
                  onSelect={setStudioKey}
                  onAsk={handlers.onAsk}
                  notify={notify}
                />
                <h2 className="section-heading">Checks and findings</h2>
                <Analyze
                  key={report.id}
                  report={report}
                  source={source}
                  h={handlers}
                />
              </>
            )}
            {tab === "compare" && (
              <>
                <StudioTab
                  view="compare"
                  source={source}
                  report={report}
                  periodStart={periodStart}
                  periodEnd={periodEnd}
                  selected={studioKey}
                  onSelect={(k) => {
                    setStudioKey(k);
                    setTab("analyze");
                  }}
                  notify={notify}
                />
                <h2 className="section-heading">Detailed comparison report</h2>
                <Compare key={report.id} report={report} source={source} />
              </>
            )}
            {tab === "builder" && (
              <StudioTab
                view="builder"
                source={source}
                report={report}
                periodStart={periodStart}
                periodEnd={periodEnd}
                selected={studioKey}
                onSelect={(k) => {
                  setStudioKey(k);
                  setTab("analyze");
                }}
                notify={notify}
              />
            )}
            {tab === "simulator" && (
              <Simulator
                key={report.id}
                report={report}
                source={source}
                canWrite={canWrite}
              />
            )}
            {tab === "chat" && (
              <Chat
                key={report.id + (askQuestion?.n || 0)}
                report={report}
                canWrite={canWrite}
                initialQuestion={askQuestion?.q || intent.question}
                autoAsk={!!askQuestion}
              />
            )}
          </>
        ) : null}
        {source &&
          tab !== "settings" &&
          session.workspace?.role === "owner" && (
            <div className="add-source">
              <Button onClick={() => setNewSource(!newSource)}>
                <Building2 size={15} /> Add another source account
              </Button>
              {newSource && (
                <NewSource
                  app={app}
                  onDone={() => {
                    setNewSource(false);
                    reload();
                  }}
                />
              )}
            </div>
          )}
      </main>
      <footer>
        <span>{p.name} · AI assessments</span>
        <span>
          Browser view refreshes on demand; source freshness is the data's as-of
          time · {source?.timezone || "Choose a source"} ·{" "}
          {report?.definitionVersion || "No data loaded"}
        </span>
      </footer>
    </>
  );
}
