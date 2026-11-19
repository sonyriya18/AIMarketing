import React from "react";
import { AlertCircle, ArrowRight, LoaderCircle } from "lucide-react";
import type { Metric } from "../shared/catalog";
export function Button({
  children,
  busy,
  primary = false,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      {...props}
      className={
        "button " + (primary ? "primary " : "") + (props.className || "")
      }
      disabled={props.disabled || busy}
    >
      {busy && <LoaderCircle size={16} className="spin" />}
      {children}
    </button>
  );
}
export function Field({
  label,
  hint,
  children,
}: React.PropsWithChildren<{ label: string; hint?: string }>) {
  const child = React.isValidElement(children)
    ? React.cloneElement(children as React.ReactElement<any>, {
        "aria-label": (children.props as any)["aria-label"] || label,
      })
    : children;
  return (
    <label className="field">
      <span>{label}</span>
      {child}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function ErrorBox({ error }: { error: unknown }) {
  return error ? (
    <div className="error" role="alert">
      <AlertCircle size={18} />
      <span>{error instanceof Error ? error.message : String(error)}</span>
    </div>
  ) : null;
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-mark">
        <ArrowRight size={24} />
      </div>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <LoaderCircle size={20} className="spin" /> Loading your workspace…
    </div>
  );
}
export function Panel({
  title,
  subtitle,
  children,
  extra,
}: {
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
  extra?: React.ReactNode;
}) {
  return (
    <section className="panel">
      {title && (
        <div className="panel-title">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {extra}
        </div>
      )}
      {children}
    </section>
  );
}
export function value(m: Metric) {
  if (m.value === null) return "Unavailable";
  const n = Number(m.value);
  if (m.unit === "money")
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: m.currency || "USD",
      maximumFractionDigits: 2,
    }).format(n);
  if (m.unit === "seconds") {
    const r = Math.round(n);
    return r >= 60
      ? `${Math.floor(r / 60)}m ${r % 60}s`
      : `${n < 10 ? n.toFixed(1).replace(/\.0$/, "") : r}s`;
  }
  return (
    new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(n) +
    (m.unit === "percent" ? "%" : m.unit === "days" ? " days" : "")
  );
}
export const date = (v: unknown) =>
  v ? new Date(String(v)).toLocaleString() : "Not yet";

/** Explains an empty page: what it is for and how to fill it. */
export function Guide({
  title,
  what,
  steps,
}: {
  title: string;
  what: string;
  steps: string[];
}) {
  return (
    <div className="guide">
      <b>{title}</b>
      <p>{what}</p>
      <ol>
        {steps.map((st) => (
          <li key={st}>{st}</li>
        ))}
      </ol>
    </div>
  );
}
