// Provider console: create client companies and choose which tools each one subscribes to.
// A company sees only the tools ticked here (inside their dates, while the company is active).
import React, { useEffect, useState } from "react";
import {
  Building2,
  ClipboardList,
  PlugZap,
  Save,
  UserPlus,
} from "lucide-react";
import { api } from "./api";
import { Button, ErrorBox, Field, Panel, date } from "./ui";
import { PRODUCTS, type ProductId } from "../shared/catalog";
import { CLIENT_TEMPLATES, type Brand } from "../shared/clients";
import { BrandEditor, BrandLogos } from "./Brand";

interface Tool {
  app: ProductId;
  enabled: boolean;
  startsAt: string | null;
  endsAt: string | null;
}
interface Company {
  id: string;
  name: string;
  slug: string;
  status: "active" | "suspended";
  responsysUrl: string | null;
  brand?: Brand;
  createdAt: string;
  tools: Tool[];
  members: number;
  admins: string[];
  member: boolean;
}
const dayOf = (v: string | null) => (v ? String(v).slice(0, 10) : "");
const slugify = (v: string) =>
  v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Tick boxes with optional start/end dates for each tool. */
function ToolPicker({
  value,
  onChange,
}: {
  value: Tool[];
  onChange: (t: Tool[]) => void;
}) {
  const get = (app: ProductId) =>
    value.find((t) => t.app === app) || {
      app,
      enabled: false,
      startsAt: null,
      endsAt: null,
    };
  const set = (app: ProductId, patch: Partial<Tool>) =>
    onChange(
      PRODUCTS.map((p) =>
        p.id === app ? { ...get(app), ...patch } : get(p.id),
      ),
    );
  return (
    <fieldset className="tool-picker">
      <legend>Subscribed tools</legend>
      {PRODUCTS.map((p) => {
        const t = get(p.id);
        return (
          <div className="tool-row" key={p.id}>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={t.enabled}
                onChange={(e) => set(p.id, { enabled: e.target.checked })}
              />
              {p.name}
            </label>
            <label className="tool-date">
              From
              <input
                type="date"
                aria-label={`${p.short} start date`}
                value={dayOf(t.startsAt)}
                disabled={!t.enabled}
                onChange={(e) =>
                  set(p.id, { startsAt: e.target.value || null })
                }
              />
            </label>
            <label className="tool-date">
              Until
              <input
                type="date"
                aria-label={`${p.short} end date`}
                value={dayOf(t.endsAt)}
                disabled={!t.enabled}
                onChange={(e) => set(p.id, { endsAt: e.target.value || null })}
              />
            </label>
          </div>
        );
      })}
      <small className="muted">
        Leave dates empty for an open-ended subscription. Dates are in UTC.
      </small>
    </fieldset>
  );
}
const payload = (tools: Tool[]) =>
  tools
    .filter((t) => t.enabled)
    .map((t) => ({
      app: t.app,
      enabled: true,
      startsAt: dayOf(t.startsAt) || null,
      endsAt: dayOf(t.endsAt) || null,
    }));

export function NewCompanyForm({
  defaultAdmin,
  onCreated,
}: {
  defaultAdmin: string;
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState(""),
    [slug, setSlug] = useState(""),
    [admin, setAdmin] = useState(defaultAdmin),
    [tools, setTools] = useState<Tool[]>([]),
    [url, setUrl] = useState(""),
    [template, setTemplate] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  return (
    <form
      className="new-company"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api("/provider/companies", {
            name,
            slug,
            adminEmail: admin,
            tools: payload(tools),
            responsysUrl: url || null,
            ...(template ? { template } : {}),
          });
          setTemplate("");
          setName("");
          setSlug("");
          setTools([]);
          setUrl("");
          await onCreated();
        } catch (err) {
          setError(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="form-row">
        <Field label="Client template" hint="Pre-fills logos, websites, context facts and marketing rules (editable later)">
          <select
            value={template}
            onChange={(e) => {
              setTemplate(e.target.value);
              const t = CLIENT_TEMPLATES.find((x) => x.key === e.target.value);
              if (t) {
                setName(t.name);
                setSlug(t.slug);
              }
            }}
          >
            <option value="">No template</option>
            {CLIENT_TEMPLATES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.brand.displayName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Company name">
          <input
            required
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setSlug(slugify(e.target.value));
            }}
            placeholder="Type any company name"
          />
        </Field>
        <Field
          label="Company address"
          hint="Used in the sign-in link: /?company=address"
        >
          <input
            required
            pattern="[a-z0-9\-]{2,60}"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
          />
        </Field>
        <Field
          label="Company administrator email"
          hint="This person manages the company's members and data"
        >
          <input
            type="email"
            required
            value={admin}
            onChange={(e) => setAdmin(e.target.value)}
          />
        </Field>
      </div>
      <ToolPicker value={tools} onChange={setTools} />
      {tools.some((t) => t.app === "responsys" && t.enabled) && (
        <Field
          label="Responsys v17 address for this company (optional)"
          hint="Leave empty to use the platform default (RESPONSYS_URL)"
        >
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://localhost:3000"
          />
        </Field>
      )}
      <Button primary busy={busy}>
        <Building2 size={16} /> Create company
      </Button>
      <ErrorBox error={error} />
    </form>
  );
}

function CompanyRow({
  c,
  onChanged,
  onOpen,
}: {
  c: Company;
  onChanged: () => Promise<void>;
  onOpen: (id: string) => Promise<void>;
}) {
  const [edit, setEdit] = useState(false),
    [branding, setBranding] = useState(false),
    [tools, setTools] = useState<Tool[]>(c.tools),
    [url, setUrl] = useState(c.responsysUrl || ""),
    [admin, setAdmin] = useState(""),
    [check, setCheck] = useState<any>(null),
    [busy, setBusy] = useState(""),
    [error, setError] = useState<unknown>(null),
    [saved, setSaved] = useState("");
  const active = c.tools.filter((t) => t.enabled);
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setSaved("");
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy("");
    }
  };
  return (
    <article className="company-card">
      <header>
        <div className="company-title">
          {c.brand?.logos?.primary && <span className="brand"><BrandLogos brand={c.brand} /></span>}
          <h3>{c.brand?.displayName || c.name}</h3>
          <small className="muted">
            /?company={c.slug} · {c.members} member(s) · created{" "}
            {date(c.createdAt)}
          </small>
        </div>
        <span className={"status-pill " + c.status}>
          {c.status === "active" ? "Active" : "Suspended"}
        </span>
      </header>
      <div className="chips" aria-label={`${c.name} subscribed tools`}>
        {active.length ? (
          active.map((t) => (
            <span className="chip" key={t.app}>
              {PRODUCTS.find((p) => p.id === t.app)!.short}
              {t.endsAt ? ` until ${dayOf(t.endsAt)}` : ""}
              {t.startsAt ? ` from ${dayOf(t.startsAt)}` : ""}
            </span>
          ))
        ) : (
          <span className="muted">No tools subscribed</span>
        )}
      </div>
      <small>Administrators: {c.admins.join(", ") || "none"}</small>
      <div className="button-row">
        <Button onClick={() => setEdit(!edit)}>
          {edit ? "Close" : "Change subscription"}
        </Button>
        <Button onClick={() => setBranding(!branding)}>
          {branding ? "Close branding" : "Branding & links"}
        </Button>
        {c.member ? (
          <Button onClick={() => run("open", () => onOpen(c.id))}>
            Open company
          </Button>
        ) : null}
        <Button
          onClick={() =>
            run("status", async () => {
              await api(
                `/provider/companies/${c.id}`,
                { status: c.status === "active" ? "suspended" : "active" },
                "PATCH",
              );
              await onChanged();
            })
          }
          busy={busy === "status"}
        >
          {c.status === "active" ? "Suspend" : "Reactivate"}
        </Button>
        <Button
          onClick={() =>
            navigator.clipboard?.writeText(
              `${location.origin}/?company=${c.slug}`,
            )
          }
        >
          <ClipboardList size={16} /> Copy sign-in link
        </Button>
      </div>
      {edit && (
        <div className="company-edit">
          <ToolPicker value={tools} onChange={setTools} />
          <Field
            label="Responsys v17 address"
            hint="Empty = platform default (RESPONSYS_URL)"
          >
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://localhost:3000"
            />
          </Field>
          <div className="button-row">
            <Button
              primary
              busy={busy === "save"}
              onClick={() =>
                run("save", async () => {
                  await api(
                    `/provider/companies/${c.id}`,
                    { tools: payload(tools), responsysUrl: url || null },
                    "PATCH",
                  );
                  setSaved("Subscription saved.");
                  await onChanged();
                })
              }
            >
              <Save size={16} /> Save subscription
            </Button>
            <Button
              busy={busy === "check"}
              onClick={() =>
                run("check", async () =>
                  setCheck(
                    await api(
                      `/provider/companies/${c.id}/responsys-check`,
                      {},
                    ),
                  ),
                )
              }
            >
              <PlugZap size={16} /> Check Responsys v17
            </Button>
          </div>
          {check && (
            <div
              className={
                "notice " + (check.state === "single_sign_on" ? "" : "warning")
              }
            >
              {check.message}
            </div>
          )}
          <form
            className="form-row"
            onSubmit={(e) => {
              e.preventDefault();
              void run("admin", async () => {
                await api(`/provider/companies/${c.id}/admins`, {
                  email: admin,
                });
                setAdmin("");
                setSaved("Administrator added.");
                await onChanged();
              });
            }}
          >
            <Field label="Add a company administrator">
              <input
                type="email"
                required
                value={admin}
                onChange={(e) => setAdmin(e.target.value)}
              />
            </Field>
            <Button busy={busy === "admin"}>
              <UserPlus size={16} /> Add administrator
            </Button>
          </form>
        </div>
      )}
      {branding && (
        <div className="company-edit">
          <BrandEditor
            value={c.brand}
            busy={busy === "brand"}
            onSave={async (b) => {
              setBusy("brand");
              try {
                await api(`/provider/companies/${c.id}`, { brand: b }, "PATCH");
                setSaved("Branding and links saved.");
                await onChanged();
              } finally {
                setBusy("");
              }
            }}
          />
        </div>
      )}
      {saved && <div className="notice">{saved}</div>}
      <ErrorBox error={error} />
    </article>
  );
}

export function ProviderConsole({
  email,
  onChanged,
  onOpen,
}: {
  email: string;
  onChanged: () => Promise<void>;
  onOpen: (id: string) => Promise<void>;
}) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState<unknown>(null);
  const load = async () => {
    try {
      setData(await api("/provider/companies"));
    } catch (err) {
      setError(err);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const refresh = async () => {
    await load();
    await onChanged();
  };
  return (
    <main className="portal provider">
      <section className="home-hero">
        <div>
          <span className="eyebrow">PLATFORM PROVIDER</span>
          <h1>Client companies and subscriptions</h1>
          <p>
            Each company sees only the tools you tick here. Company
            administrators manage their own members and data, but cannot change
            their subscription.
          </p>
        </div>
      </section>
      <ErrorBox error={error} />
      <Panel
        title="Add a client company"
        subtitle="Add as many client companies as you need, with any names. Tick the tools each one gets."
      >
        <NewCompanyForm defaultAdmin={email} onCreated={refresh} />
      </Panel>
      <Panel
        title={`Companies (${data?.companies?.length ?? "…"})`}
        subtitle={
          data
            ? `Responsys single sign-on: ${data.ssoConfigured ? "set up" : "not set up (Responsys opens with its own sign-in)"} · default Responsys address: ${data.responsysDefaultUrl || "not set"}`
            : undefined
        }
      >
        <div className="company-list">
          {(data?.companies || []).map((c: Company) => (
            <CompanyRow
              key={c.id + JSON.stringify(c.tools) + c.status + c.responsysUrl}
              c={c}
              onChanged={refresh}
              onOpen={onOpen}
            />
          ))}
          {data && !data.companies.length && (
            <p className="muted">No companies yet. Add the first one above.</p>
          )}
        </div>
      </Panel>
    </main>
  );
}
