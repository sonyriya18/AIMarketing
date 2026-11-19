// Client branding on screen: logos, official websites, context facts, marketing rules, the
// client's own Oracle application links and Oracle documentation. Configured per company by the
// platform provider (Provider console → Branding & links).
import React, { useState } from "react";
import {
  BookOpen,
  ExternalLink,
  Globe,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Button, ErrorBox, Field } from "./ui";
import { product, type ProductId } from "../shared/catalog";
import {
  BUNDLED_LOGOS,
  CLIENT_TEMPLATES,
  PRODUCT_DOCS,
  SECTOR_LABEL,
  type Brand,
} from "../shared/clients";

const safe = (url?: string) =>
  url && /^https:\/\//.test(url) ? url : undefined;

/** Header logos: the client's main logo and, when set, its retail brand. */
export function BrandLogos({
  brand,
  fallback,
}: {
  brand?: Brand;
  fallback?: string | null;
}) {
  const logos = [brand?.logos?.primary, brand?.logos?.secondary].filter(
    Boolean,
  ) as string[];
  if (!logos.length && fallback) return <img src={fallback} alt="" />;
  if (!logos.length) return <span className="brandmark">AI</span>;
  return (
    <span className="brand-logos">
      {logos.map((src, i) => (
        <img
          key={src}
          src={src}
          alt={
            i === 0 ? `${brand?.displayName || "Client"} logo` : "Brand logo"
          }
        />
      ))}
    </span>
  );
}

/** Home-page client panel. Only links for the company's subscribed applications are shown. */
export function ClientPanel({
  brand,
  products,
  name,
}: {
  brand?: Brand;
  products: ProductId[];
  name: string;
}) {
  if (!brand || !Object.keys(brand).length) return null;
  const links = (brand.links || []).filter((l) => safe(l.url));
  return (
    <section
      className="client-panel"
      style={{ borderTopColor: brand.color || undefined }}
      aria-label="Client profile"
    >
      <div className="client-head">
        <div className="client-logos">
          {brand.logos?.primary && (
            <img src={brand.logos.primary} alt={`${name} logo`} />
          )}
          {brand.logos?.secondary && (
            <img src={brand.logos.secondary} alt="Retail brand logo" />
          )}
        </div>
        <div>
          <h2>{brand.displayName || name}</h2>
          {brand.summary && <p>{brand.summary}</p>}
          <div className="chips">
            {brand.sector && (
              <span className="chip">{SECTOR_LABEL[brand.sector]}</span>
            )}
            {brand.timezone && <span className="chip">{brand.timezone}</span>}
            {brand.currency && <span className="chip">{brand.currency}</span>}
            {links.map((l) => (
              <a
                key={l.url}
                className="chip link-chip"
                href={l.url}
                target="_blank"
                rel="noreferrer"
              >
                <Globe size={12} /> {l.label} <ExternalLink size={11} />
              </a>
            ))}
          </div>
        </div>
      </div>
      <div className="client-grid">
        {!!brand.facts?.length && (
          <div>
            <h3>
              <Sparkles size={15} /> What the AI knows about this client
            </h3>
            <ul className="facts">
              {brand.facts.map((f) => (
                <li key={f.id}>
                  <span className="mono">{f.id}</span> {f.text}{" "}
                  <a
                    href={f.source}
                    target="_blank"
                    rel="noreferrer"
                    className="muted"
                  >
                    source
                  </a>
                </li>
              ))}
            </ul>
            {brand.researchedOn && (
              <small className="muted">
                Read from the official websites on {brand.researchedOn}. Context
                only, never campaign results.
              </small>
            )}
          </div>
        )}
        {!!brand.guardrails?.length && (
          <div>
            <h3>
              <ShieldCheck size={15} /> Marketing rules applied by the AI
            </h3>
            <ul className="facts">
              {brand.guardrails.map((g, i) => (
                <li key={i}>{g}</li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <h3>
            <BookOpen size={15} /> Applications and documentation
          </h3>
          <ul className="facts">
            {products.map((p) => {
              const app = safe(brand.appLinks?.[p]);
              return (
                <li key={p}>
                  <b>{product(p).name}</b>:{" "}
                  {app ? (
                    <a href={app} target="_blank" rel="noreferrer">
                      open {product(p).short} <ExternalLink size={11} />
                    </a>
                  ) : (
                    <span className="muted">
                      client login address not configured
                    </span>
                  )}
                  {PRODUCT_DOCS[p].map((d) => (
                    <span key={d.url}>
                      {" "}
                      ·{" "}
                      <a href={d.url} target="_blank" rel="noreferrer">
                        {d.label}
                      </a>
                    </span>
                  ))}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}

const lines = (v: string) =>
  v
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

/** Provider editor for a company's branding and links. */
export function BrandEditor({
  value,
  onSave,
  busy,
}: {
  value?: Brand;
  onSave: (b: Brand) => Promise<void>;
  busy?: boolean;
}) {
  const [b, setB] = useState<Brand>(value || {});
  const [linksText, setLinksText] = useState(
    (value?.links || []).map((l) => `${l.label} | ${l.url}`).join("\n"),
  );
  const [factsText, setFactsText] = useState(
    (value?.facts || []).map((f) => `${f.text} | ${f.source}`).join("\n"),
  );
  const [rulesText, setRulesText] = useState(
    (value?.guardrails || []).join("\n"),
  );
  const [error, setError] = useState<unknown>(null);
  const set = (patch: Partial<Brand>) => setB((x) => ({ ...x, ...patch }));
  const apply = (key: string) => {
    const t = CLIENT_TEMPLATES.find((x) => x.key === key);
    if (!t) return;
    setB(structuredClone(t.brand));
    setLinksText(
      (t.brand.links || []).map((l) => `${l.label} | ${l.url}`).join("\n"),
    );
    setFactsText(
      (t.brand.facts || []).map((f) => `${f.text} | ${f.source}`).join("\n"),
    );
    setRulesText((t.brand.guardrails || []).join("\n"));
  };
  const logoField = (k: "primary" | "secondary" | "onDark", label: string) => (
    <Field label={label} hint="A bundled logo, or an https:// image address">
      <input
        list="bundled-logos"
        value={b.logos?.[k] || ""}
        onChange={(e) => set({ logos: { ...b.logos, [k]: e.target.value } })}
      />
    </Field>
  );
  return (
    <div className="brand-editor">
      <datalist id="bundled-logos">
        {BUNDLED_LOGOS.map((l) => (
          <option key={l} value={l} />
        ))}
      </datalist>
      <div className="form-row">
        <Field label="Start from a client template">
          <select defaultValue="" onChange={(e) => apply(e.target.value)}>
            <option value="">Choose…</option>
            {CLIENT_TEMPLATES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.brand.displayName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Display name">
          <input
            value={b.displayName || ""}
            onChange={(e) => set({ displayName: e.target.value })}
          />
        </Field>
        <Field label="Brand colour">
          <input
            value={b.color || ""}
            placeholder="#1c4220"
            onChange={(e) => set({ color: e.target.value })}
          />
        </Field>
        <Field label="Sector">
          <select
            value={b.sector || "general"}
            onChange={(e) => set({ sector: e.target.value as Brand["sector"] })}
          >
            <option value="general">General business</option>
            <option value="liquor_retail">Liquor retail</option>
          </select>
        </Field>
      </div>
      <Field label="Short description">
        <input
          value={b.summary || ""}
          onChange={(e) => set({ summary: e.target.value })}
        />
      </Field>
      <div className="form-row">
        {logoField("primary", "Main logo")}
        {logoField("secondary", "Retail brand logo")}
        {logoField("onDark", "Logo for dark backgrounds")}
      </div>
      <div className="form-row">
        <Field label="Official website">
          <input
            value={b.website || ""}
            placeholder="https://"
            onChange={(e) => set({ website: e.target.value })}
          />
        </Field>
        {(["responsys", "eloqua", "unity", "infinity"] as ProductId[]).map(
          (p) => (
            <Field
              key={p}
              label={`${product(p).short} login address`}
              hint="The client's own Oracle address (optional)"
            >
              <input
                value={b.appLinks?.[p] || ""}
                placeholder="https://"
                onChange={(e) =>
                  set({ appLinks: { ...b.appLinks, [p]: e.target.value } })
                }
              />
            </Field>
          ),
        )}
      </div>
      <Field label="Website links (one per line: label | https address)">
        <textarea
          rows={3}
          value={linksText}
          onChange={(e) => setLinksText(e.target.value)}
        />
      </Field>
      <Field
        label="Context facts for the AI (one per line: fact | https source)"
        hint="Only facts from official sources; they are shown with their source"
      >
        <textarea
          rows={5}
          value={factsText}
          onChange={(e) => setFactsText(e.target.value)}
        />
      </Field>
      <Field label="Marketing rules (one per line)">
        <textarea
          rows={3}
          value={rulesText}
          onChange={(e) => setRulesText(e.target.value)}
        />
      </Field>
      <Button
        primary
        busy={busy}
        onClick={async () => {
          setError(null);
          try {
            const links = lines(linksText).map((l) => {
              const [label, url] = l.split("|").map((x) => x.trim());
              return { label: label || url || "", url: url || label || "" };
            });
            const facts = lines(factsText).map((l, i) => {
              const [text, source] = l.split("|").map((x) => x.trim());
              return {
                id: `W${i + 1}`,
                text: text || "",
                source: source || "",
              };
            });
            await onSave({ ...b, links, facts, guardrails: lines(rulesText) });
          } catch (e) {
            setError(e);
          }
        }}
      >
        Save branding & links
      </Button>
      <ErrorBox error={error} />
    </div>
  );
}
