// Sign-in flow (company account → sign in → application) and the AI home page.
import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  Building2,
  CheckCircle2,
  ClipboardList,
  Clock,
  FileText,
  Microscope,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  Wand2,
} from "lucide-react";
import { api } from "./api";
import { responsysState, useResponsysStatus } from "./Responsys";
import { Button, Field, ErrorBox, Empty, Panel, date } from "./ui";
import {
  ROLE_LABEL,
  product,
  isApp,
  type ProductId,
  type Session,
  type Tab,
} from "../shared/catalog";
import { SettingsPage } from "./DataAdmin";
import { NewCompanyForm } from "./Provider";

export interface Intent {
  tab?: Tab;
  sourceId?: string;
  question?: string;
}
const store = {
  get: (k: string) => {
    try {
      return sessionStorage.getItem(k) || "";
    } catch {
      return "";
    }
  },
  set: (k: string, v: string) => {
    try {
      if (v) sessionStorage.setItem(k, v);
      else sessionStorage.removeItem(k);
    } catch {
      /* storage unavailable: the flow still works without remembering the company */
    }
  },
};
export const pendingCompany = {
  get: () => store.get("oap.company"),
  clear: () => store.set("oap.company", ""),
};

export function Login({ onDone }: { onDone: () => Promise<void> }) {
  const params = new URLSearchParams(location.search);
  const [config, setConfig] = useState<any>(),
    [step, setStep] = useState<1 | 2>(params.get("company") ? 2 : 1),
    [slug, setSlug] = useState(
      params.get("company") || store.get("oap.company"),
    ),
    [brand, setBrand] = useState<any>(null),
    [email, setEmail] = useState(""),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api("/auth/config").then(setConfig).catch(setError);
  }, []);
  useEffect(() => {
    if (!slug || step !== 2) return;
    api("/brand/" + encodeURIComponent(slug))
      .then(setBrand)
      .catch(() => setBrand(null));
  }, [slug, step]);
  const signIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    store.set("oap.company", slug);
    try {
      if (config?.mode === "dev") {
        await api("/auth/dev-login", { email });
        await onDone();
      } else location.assign("/api/auth/login");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="welcome">
      <div className="welcome-story">
        <span className="eyebrow">ORACLE AI ASSESSMENT PLATFORM</span>
        <h1>
          Evidence first.
          <br />
          Clear next steps.
        </h1>
        <p>
          One sign-in for your company's Oracle applications. Each application's
          data is assessed by deterministic rules; AI explains the evidence,
          drafts the follow-up and never invents numbers.
        </p>
        <ol className="steps-visual" aria-label="How it works">
          <li className={step === 1 ? "current" : "done"}>
            <Building2 size={16} /> Company account
          </li>
          <li className={step === 2 ? "current" : ""}>
            <ShieldCheck size={16} /> Verified sign-in
          </li>
          <li>
            <Sparkles size={16} /> Your applications and AI briefing
          </li>
        </ol>
        <div className="product-strip">
          Responsys <span>·</span> Eloqua <span>·</span> Unity <span>·</span>{" "}
          Infinity
        </div>
      </div>
      <div className="login">
        {step === 2 && (brand?.brandLogo || brand?.logo) ? (
          <img
            className="login-logo"
            src={brand.brandLogo || brand.logo}
            alt=""
          />
        ) : (
          <span className="brandmark">AI</span>
        )}
        {step === 1 ? (
          <>
            <h2>Find your company</h2>
            <p>
              Enter your company's workspace address, or continue and choose it
              after signing in.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setStep(2);
              }}
            >
              <Field
                label="Company workspace address"
                hint="For example jade or dan-murphys. Your administrator can send you a direct link."
              >
                <input
                  value={slug}
                  onChange={(e) =>
                    setSlug(
                      e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""),
                    )
                  }
                  placeholder="your-company"
                  autoComplete="organization"
                />
              </Field>
              <Button primary type="submit">
                Continue <ArrowRight size={16} />
              </Button>
            </form>
          </>
        ) : (
          <>
            <h2>{brand ? `Sign in to ${brand.name}` : "Sign in"}</h2>
            <p>
              {brand
                ? "Your identity is verified before any company data is shown."
                : slug
                  ? "This address was not recognized. You can still sign in and choose your company."
                  : "Sign in, then choose your company."}
            </p>
            {config?.mode === "dev" && (
              <div className="notice">
                Local development sign-in: typing an email is not authentication
                and is disabled in production.
              </div>
            )}
            <form onSubmit={signIn}>
              {config?.mode === "dev" && (
                <Field label="Work email">
                  <input
                    type="email"
                    required
                    autoComplete="email"
                    placeholder="you@company.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </Field>
              )}
              <Button primary type="submit" busy={busy} disabled={!config}>
                {config?.mode === "oidc"
                  ? `Continue with ${config.provider}`
                  : "Continue"}{" "}
                <ArrowRight size={16} />
              </Button>
            </form>
            <button className="link small" onClick={() => setStep(1)}>
              Use a different company
            </button>
          </>
        )}
        <ErrorBox error={error} />
      </div>
    </div>
  );
}

export function Setup({
  session,
  onDone,
}: {
  session: Session;
  onDone: () => Promise<void>;
}) {
  return (
    <main className="setup">
      <div className="eyebrow">
        {session.provider ? "PLATFORM PROVIDER" : "WELCOME"}
      </div>
      <h1>
        {session.provider
          ? "Add your first client company"
          : "Your sign-in is not linked to a company yet"}
      </h1>
      {session.workspaces.map((w) => (
        <Button
          key={w.id}
          onClick={async () => {
            await api("/session/workspace", { id: w.id });
            await onDone();
          }}
        >
          Open {w.name}
        </Button>
      ))}
      {session.provider ? (
        <Panel
          title="Client company"
          subtitle="Choose the tools in the company's subscription. The company will see only these tools."
        >
          <p className="muted">
            Use your own email as the administrator to open the company straight
            away, or another person's email to hand it over.
          </p>
          <NewCompanyForm
            defaultAdmin={session.user.email}
            onCreated={onDone}
          />
        </Panel>
      ) : (
        <Panel>
          <p>
            Signed in as <b>{session.user.email}</b>. Ask your platform provider
            or your company administrator to add this email to your company,
            then sign in again.
          </p>
        </Panel>
      )}
    </main>
  );
}

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};
export function Home({
  session,
  onChoose,
  onSettingsChange,
  onProvider,
}: {
  session: Session;
  onChoose: (id: ProductId | "cross", intent?: Intent) => void;
  onSettingsChange: () => Promise<void>;
  onProvider: () => void;
}) {
  const rStatus = useResponsysStatus(session.products.includes("responsys"));
  const [home, setHome] = useState<any>(null),
    [error, setError] = useState<unknown>(null),
    [chosen, setChosen] = useState<ProductId | "">(""),
    [question, setQuestion] = useState(""),
    [routing, setRouting] = useState<any>(null),
    [busy, setBusy] = useState(""),
    [briefing, setBriefing] = useState<any>(null),
    [settings, setSettings] = useState(false);
  useEffect(() => {
    api("/home").then(setHome).catch(setError);
  }, [session.workspace?.id]);
  const analytic = session.products.filter(isApp);
  const byApp = useMemo(() => {
    const m: Record<string, any[]> = {};
    for (const s of home?.sources || []) (m[s.app] ||= []).push(s);
    return m;
  }, [home]);
  const attention = useMemo(
    () =>
      (home?.sources || [])
        .flatMap((s: any) =>
          (s.assessment?.top || []).map((f: any) => ({ ...f, source: s })),
        )
        .sort(
          (a: any, b: any) =>
            ["high", "medium", "low", "info"].indexOf(a.severity) -
            ["high", "medium", "low", "info"].indexOf(b.severity),
        )
        .slice(0, 6),
    [home],
  );
  const queue = useMemo(() => {
    const q: {
      icon: React.ElementType;
      text: string;
      app: string;
      sourceId: string;
      tab: Tab;
    }[] = [];
    for (const s of home?.sources || []) {
      const where = `${product(s.app).short} · ${s.name}`;
      if (s.overdue)
        q.push({
          icon: Clock,
          text: `${s.overdue} overdue action(s) — ${where}`,
          app: s.app,
          sourceId: s.id,
          tab: "actions",
        });
      if (s.reviews && session.workspace?.permissions?.includes("approvals"))
        q.push({
          icon: FileText,
          text: `${s.reviews} draft(s) waiting for your review — ${where}`,
          app: s.app,
          sourceId: s.id,
          tab: "drafts",
        });
      if (s.unread)
        q.push({
          icon: Bell,
          text: `${s.unread} unread notification(s) — ${where}`,
          app: s.app,
          sourceId: s.id,
          tab: "notifications",
        });
      if (s.investigations)
        q.push({
          icon: Microscope,
          text: `${s.investigations} open investigation(s) — ${where}`,
          app: s.app,
          sourceId: s.id,
          tab: "investigations",
        });
      if (!s.dataset)
        q.push({
          icon: AlertTriangle,
          text: `No data yet — ${where}`,
          app: s.app,
          sourceId: s.id,
          tab: "data",
        });
      else if (s.dataset.stale)
        q.push({
          icon: AlertTriangle,
          text: `Stale data (as of ${date(s.dataset.asOf)}) — ${where}`,
          app: s.app,
          sourceId: s.id,
          tab: "data",
        });
      if (s.connection?.last_error)
        q.push({
          icon: AlertTriangle,
          text: `Connection problem — ${where}`,
          app: s.app,
          sourceId: s.id,
          tab: "data",
        });
    }
    return q;
  }, [home]);
  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("route");
    setError(null);
    try {
      const r = await api("/home/route", { question });
      setRouting(r);
      if (r.app) onChoose(r.app, { tab: "chat", question });
    } catch (err) {
      setError(err);
    } finally {
      setBusy("");
    }
  };
  return (
    <main className="portal home">
      <section className="home-hero">
        <div>
          <span className="eyebrow">
            {session.workspace!.name.toUpperCase()}
          </span>
          <h1>
            {greeting()}, {session.user.email.split("@")[0]}
          </h1>
          <p>
            {ROLE_LABEL[session.workspace!.role]} ·{" "}
            {new Date().toLocaleDateString(undefined, {
              weekday: "long",
              day: "numeric",
              month: "long",
            })}{" "}
            · {analytic.length} assessment application(s)
            {session.products.includes("responsys") ? " + Responsys" : ""}
          </p>
        </div>
        {analytic.length > 0 && (
          <form className="ask-anything" onSubmit={ask}>
            <Field label="Ask across your applications">
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="e.g. Which campaigns need review this week? Why is the newsletter audience not ready?"
                minLength={2}
                required
              />
            </Field>
            <Button primary busy={busy === "route"}>
              <Wand2 size={16} /> Ask
            </Button>
            {routing && !routing.app && (
              <div className="notice">
                {routing.reason}.{" "}
                {analytic.map((a) => (
                  <Button
                    key={a}
                    onClick={() => onChoose(a, { tab: "chat", question })}
                  >
                    Ask {product(a).short}
                  </Button>
                ))}
              </div>
            )}
          </form>
        )}
      </section>
      <ErrorBox error={error} />
      {analytic.length > 0 && (
        <div className="home-grid">
          <Panel
            title="What needs attention"
            subtitle="Top signals from each source's latest assessment, ordered by the published priority rule."
            extra={
              <Button
                busy={busy === "brief"}
                onClick={async () => {
                  setBusy("brief");
                  try {
                    setBriefing(await api("/home/briefing", {}));
                  } catch (e) {
                    setError(e);
                  } finally {
                    setBusy("");
                  }
                }}
              >
                <Sparkles size={15} /> Write AI briefing
              </Button>
            }
          >
            {briefing && (
              <div className="briefing">
                <span
                  className={
                    "badge " + (briefing.generator === "ai" ? "ai" : "rules")
                  }
                >
                  {briefing.generator === "ai"
                    ? `AI briefing · ${briefing.model}`
                    : "Rule-based briefing (no AI)"}
                </span>{" "}
                <small className="muted">{briefing.status}</small>
                <ul>
                  {briefing.statements.map((s: any, i: number) => (
                    <li key={i} className={"brief-" + s.kind}>
                      <b>
                        {s.kind === "priority"
                          ? "Priority"
                          : s.kind === "watch"
                            ? "Watch"
                            : "Data gap"}
                        :
                      </b>{" "}
                      {s.text}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {attention.length ? (
              <ul className="attention">
                {attention.map((f: any) => (
                  <li key={f.source.id + f.id}>
                    <button
                      className="link"
                      onClick={() =>
                        onChoose(f.source.app, {
                          tab: "summary",
                          sourceId: f.source.id,
                        })
                      }
                    >
                      <span className={"badge sev-" + f.severity}>
                        {f.severity}
                      </span>{" "}
                      <b>{f.title}</b>
                      <small>
                        {product(f.source.app).short} · {f.source.name} —{" "}
                        {f.detail}
                      </small>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">
                {home
                  ? "No assessed sources yet. Open an application, upload an export and view its Summary."
                  : "Loading…"}
              </p>
            )}
          </Panel>
          <Panel
            title="Your work queue"
            subtitle="Follow-up that is waiting on you or your team."
          >
            {queue.length ? (
              <ul className="queue">
                {queue.map((q, i) => (
                  <li key={i}>
                    <button
                      className="link"
                      onClick={() =>
                        onChoose(q.app as ProductId, {
                          tab: q.tab,
                          sourceId: q.sourceId,
                        })
                      }
                    >
                      <q.icon size={15} /> {q.text}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">
                <CheckCircle2 size={15} /> Nothing waiting.
              </p>
            )}
          </Panel>
        </div>
      )}
      <Panel>
        <form
          className="launch-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (chosen) onChoose(chosen);
          }}
        >
          <Field label="Select your application">
            <select
              required
              value={chosen}
              onChange={(e) => setChosen(e.target.value as ProductId)}
            >
              <option value="">Choose an application</option>
              {session.products.map((id) => (
                <option key={id} value={id}>
                  {product(id).name}
                </option>
              ))}
            </select>
          </Field>
          <Button primary disabled={!chosen}>
            Open application <ArrowRight size={16} />
          </Button>
        </form>
      </Panel>
      <div className="product-grid">
        {session.products.map((id) => {
          const p = product(id);
          const srcs = byApp[id] || [];
          const high = srcs.reduce((n, s) => n + (s.assessment?.high || 0), 0);
          const latest = srcs
            .map((s) => s.dataset?.asOf)
            .filter(Boolean)
            .sort()
            .at(-1);
          return (
            <button
              key={id}
              className="product-card"
              onClick={() => onChoose(id)}
            >
              <h2>{p.name}</h2>
              <p>{p.description}</p>
              {id === "responsys" ? (
                <dl className="card-stats">
                  <dt>Status</dt>
                  <dd>{responsysState(rStatus)}</dd>
                  <dt>AI</dt>
                  <dd>{rStatus?.ai || "—"}</dd>
                  <dt>Connection</dt>
                  <dd>Uploads or Responsys API</dd>
                </dl>
              ) : (
                <dl className="card-stats">
                  <dt>Sources</dt>
                  <dd>{srcs.length || "—"}</dd>
                  <dt>High-priority signals</dt>
                  <dd>
                    {srcs.some((s) => s.assessment) ? high : "Not assessed"}
                  </dd>
                  <dt>Latest data</dt>
                  <dd>{latest ? date(latest) : "No data"}</dd>
                  <dt>Connection</dt>
                  <dd>
                    {srcs
                      .find((s) => s.connection)
                      ?.connection?.verification?.replaceAll("_", " ") ||
                      "Uploads only"}
                  </dd>
                </dl>
              )}
              <span className="product-open">
                Open workspace <ArrowRight size={16} />
              </span>
            </button>
          );
        })}
      </div>
      {!session.products.length && (
        <Empty
          title={
            session.workspace?.status === "suspended"
              ? "This company's subscription is suspended"
              : "No tools in your subscription"
          }
        >
          {session.workspace?.status === "suspended"
            ? "Your data is kept. Contact your platform provider to reactivate the subscription."
            : "Ask your platform provider to add tools to your company's subscription, or your administrator to give you access."}
        </Empty>
      )}
      {(session.workspace?.role === "owner" || session.provider) && (
        <>
          <div className="button-row">
            {session.workspace?.role === "owner" && (
              <Button onClick={() => setSettings(!settings)}>
                <SettingsIcon size={16} /> Workspace settings
              </Button>
            )}
            {session.provider && (
              <Button onClick={onProvider}>
                <Building2 size={16} /> Client companies and subscriptions
              </Button>
            )}
            <Button
              onClick={() =>
                navigator.clipboard?.writeText(
                  `${location.origin}/?company=${session.workspace!.slug}`,
                )
              }
            >
              <ClipboardList size={16} /> Copy company sign-in link
            </Button>
          </div>
          {settings && (
            <SettingsPage session={session} onDone={onSettingsChange} />
          )}
        </>
      )}
    </main>
  );
}
