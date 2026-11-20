// Responsys inside the platform window, like Eloqua, Unity and Infinity. The unmodified Responsys
// app is shown in a frame under the platform header; it signs in through the platform (single
// sign-on), which checks the company's Responsys subscription.
import React, { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "./api";
import { Button, ErrorBox } from "./ui";
import { DocsLink } from "./Brand";
import { product, type ProductId, type Session } from "../shared/catalog";

export interface ResponsysStatus {
  state: string;
  message: string;
  signIn: string;
  ai: string;
  opens: string;
}

export function useResponsysStatus(enabled: boolean) {
  const [status, setStatus] = useState<ResponsysStatus | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api<ResponsysStatus>("/responsys/status")
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus(null));
    return () => {
      live = false;
    };
  }, [enabled]);
  return status;
}

const STATE_LABEL: Record<string, string> = {
  running: "Running",
  starting: "Starting…",
  stopped: "Stopped (see the reason when opening)",
  missing: "Not set up yet",
  not_configured: "Not set up",
  external: "Company address",
};
export const responsysState = (s: ResponsysStatus | null) =>
  s ? STATE_LABEL[s.state] || s.state : "Checking…";

export function ResponsysFrame({
  session,
  onSwitch,
}: {
  session: Session;
  onSwitch: (id: ProductId) => void;
}) {
  const [url, setUrl] = useState(""),
    [n, setN] = useState(0),
    [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    setError(null);
    api("/responsys")
      .then((r) => live && setUrl(r.url))
      .catch((e) => live && setError(e));
    return () => {
      live = false;
    };
  }, [n]);
  return (
    <>
      <div className="application-nav">
        <div className="app-picker">
          <select
            aria-label="Application"
            value="responsys"
            onChange={(e) => onSwitch(e.target.value as ProductId)}
          >
            {session.products.map((id) => (
              <option key={id} value={id}>
                {product(id).name}
              </option>
            ))}
          </select>
        </div>
        <nav
          className="context-actions responsys-tools"
          aria-label="Responsys tools"
        >
          <Button onClick={() => setN((x) => x + 1)}>
            <RefreshCw size={15} /> Reload Responsys
          </Button>
          <DocsLink app="responsys" />
        </nav>
      </div>
      <ErrorBox error={error} />
      {url && (
        <iframe
          key={n}
          className="responsys-frame"
          title="Oracle Responsys"
          src={url}
          allow="clipboard-write"
        />
      )}
    </>
  );
}
