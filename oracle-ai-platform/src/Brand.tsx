// Client branding on screen: the client's logo in the header, Oracle documentation links, and the
// provider's editor for logos, websites, context facts, marketing rules and the client's own
// Oracle login addresses (Provider console → Branding & links).
import React, { useState } from "react";
import { BookOpen, ExternalLink } from "lucide-react";
import { Button, ErrorBox, Field } from "./ui";
import { product, type ProductId } from "../shared/catalog";
import {
  BUNDLED_LOGOS,
  CLIENT_TEMPLATES,
  PRODUCT_DOCS,
  type Brand,
} from "../shared/clients";

const safe = (url?: string) =>
  url && /^https:\/\//.test(url) ? url : undefined;

/** Header logo: the client's own logo (the white version on the dark header when there is one). */
export function BrandLogos({
  brand,
  fallback,
  light,
}: {
  brand?: Brand;
  fallback?: string | null;
  /** On a light background: always the main logo. */
  light?: boolean;
}) {
  const name = brand?.displayName || "Client";
  if (brand?.logos?.onDark && !light)
    return (
      <img
        className="brand-logo-dark"
        src={brand.logos.onDark}
        alt={`${name} logo`}
      />
    );
  if (brand?.logos?.primary)
    return (
      <span className="brand-logos">
        <img src={brand.logos.primary} alt={`${name} logo`} />
      </span>
    );
  if (fallback) return <img src={fallback} alt="" />;
  return <span className="brandmark">AI</span>;
}

/** Link to the product's official Oracle documentation, shown in each application's toolbar. */
export function DocsLink({ app }: { app: ProductId }) {
  const doc = PRODUCT_DOCS[app]?.[0];
  if (!doc) return null;
  return (
    <a
      className="docs-link"
      href={doc.url}
      target="_blank"
      rel="noreferrer"
      title={doc.label}
    >
      <BookOpen size={15} /> Oracle docs <ExternalLink size={11} />
    </a>
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
