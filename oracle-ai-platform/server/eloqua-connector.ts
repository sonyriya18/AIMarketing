// Oracle Eloqua read adapter.
// Contracts used (see docs/connectors/ELOQUA.md for official references O1–O4, O13):
//   GET  https://login.eloqua.com/id                      base URL discovery (never hardcode a pod)
//   GET  {base}/api/REST/2.0/assets/campaigns?page=&count=  Application API campaign metadata
//   POST {base}/api/bulk/2.0/activities/exports            Bulk export definition (one activity type)
//   POST {base}/api/bulk/2.0/syncs                          start a sync of that export
//   GET  {base}/api/bulk/2.0/syncs/{id}                     poll status: pending|active|success|warning|error
//   GET  {base}/api/bulk/2.0/syncs/{id}/data?offset=&limit= paged retrieval (hasMore)
//   DELETE {base}/api/bulk/2.0/activities/exports/{id}      clean up this connector's own export definition
// The extraction POSTs create temporary export resources only; they never change campaigns,
// contacts or assets. Field names below follow the activity-field reference and must be
// confirmed for the tenant's release before connecting (providerContractConfirmed).
import type { RecordData } from "../shared/catalog";
import type { Config } from "./config";
import {
  request,
  ProviderError,
  PendingExport,
  type ConnectorConfig,
  type Secrets,
} from "./connectors";
import { validateRecords } from "./imports";

export const ELOQUA_ACTIVITY_TYPES = [
  "EmailSend",
  "EmailOpen",
  "EmailClickthrough",
  "Bounceback",
  "Unsubscribe",
  "FormSubmit",
] as const;
const common = {
  id: "{{Activity.Id}}",
  activityDate: "{{Activity.CreatedAt}}",
  contactId: "{{Activity.Contact.Id}}",
  campaignId: "{{Activity.Campaign.Id}}",
  assetId: "{{Activity.Asset.Id}}",
};
export const DEFAULT_ACTIVITY_FIELDS: Record<string, Record<string, string>> = {
  EmailSend: {
    ...common,
    deploymentId: "{{Activity.Field(EmailDeploymentId)}}",
  },
  EmailOpen: {
    ...common,
    deploymentId: "{{Activity.Field(EmailDeploymentId)}}",
  },
  EmailClickthrough: {
    ...common,
    deploymentId: "{{Activity.Field(EmailDeploymentId)}}",
  },
  Bounceback: { ...common },
  Unsubscribe: { ...common },
  FormSubmit: { ...common },
};
const PAGE = 50_000;
const MAX_ROWS = 25_000;

export function eloquaAuth(
  c: ConnectorConfig,
  s: Secrets,
): Record<string, string> {
  if (c.auth === "eloqua-basic") {
    if (!s.siteName || !s.username || !s.password)
      throw new ProviderError(
        "Eloqua company (site) name, username and password are required",
      );
    return {
      Authorization:
        "Basic " +
        Buffer.from(`${s.siteName}\\${s.username}:${s.password}`).toString(
          "base64",
        ),
    };
  }
  throw new ProviderError(
    "Use eloqua-basic or a verified OAuth authorization for Eloqua",
  );
}

/** Discover the tenant's base URL; the discovered host must already be an approved outbound host. */
export async function discoverBase(
  cfg: Config,
  headers: Record<string, string>,
  loginUrl = "https://login.eloqua.com/id",
) {
  const r = await request(loginUrl, cfg, { headers });
  let body: any;
  try {
    body = JSON.parse(r.text);
  } catch {
    throw new ProviderError("Eloqua identity endpoint returned invalid JSON");
  }
  if (body === "Not authenticated." || !body?.urls?.base)
    throw new ProviderError(
      "Eloqua did not authenticate this user or returned no base URL",
    );
  const base = new URL(String(body.urls.base));
  if (!cfg.allowedHosts.includes(base.hostname.toLowerCase()))
    throw new ProviderError(
      `Add the discovered Eloqua host ${base.hostname} to OUTBOUND_HOSTS before syncing`,
    );
  return {
    base: base.origin,
    site: String(body.site?.name || ""),
    user: String(body.user?.username || ""),
  };
}
const epochToIso = (v: unknown) => {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n)
    ? null
    : new Date(n * 1000).toISOString().slice(0, 10);
};
async function json(url: string, cfg: Config, init: RequestInit) {
  const r = await request(url, cfg, init);
  try {
    return {
      status: r.response.status,
      body: r.text ? JSON.parse(r.text) : null,
    };
  } catch {
    throw new ProviderError("Eloqua returned invalid JSON");
  }
}
export async function readCampaigns(
  base: string,
  cfg: Config,
  headers: Record<string, string>,
) {
  const out: RecordData[] = [];
  for (let page = 1; ; page++) {
    if (page > 200)
      throw new ProviderError(
        "Campaign listing exceeded 200 pages; narrow the scope",
      );
    const { body } = await json(
      `${base}/api/REST/2.0/assets/campaigns?depth=minimal&count=1000&page=${page}`,
      cfg,
      { headers },
    );
    if (!Array.isArray(body?.elements) || typeof body.total !== "number")
      throw new ProviderError(
        "Unexpected campaign response: elements and total are required",
      );
    for (const e of body.elements)
      out.push({
        type: "campaign",
        id: String(e.id),
        name: e.name ?? null,
        status: e.currentStatus ?? null,
        campaignType:
          e.isEmailMarketingCampaign === "true"
            ? "simple"
            : (e.campaignCategory ?? null),
        startDate: epochToIso(e.startAt),
        endDate: epochToIso(e.endAt),
        folder: e.folderId ? String(e.folderId) : null,
      });
    if (out.length >= body.total || !body.elements.length) break;
  }
  return out;
}
export interface BulkState {
  types: {
    type: string;
    exportUri?: string;
    syncUri?: string;
    status?: string;
  }[];
  owned: string[];
  since: string;
  until: string;
  startedAt: string;
  campaigns?: number;
}
/**
 * Runs or resumes the activity export lifecycle. Throws PendingExport with a checkpoint while a
 * sync is still processing, so the durable job re-queues without creating a new export.
 */
export async function readEloqua(
  c: ConnectorConfig,
  secrets: Secrets,
  cfg: Config,
  opts: {
    checkpoint?: Record<string, unknown>;
    checkOnly?: boolean;
    saveCheckpoint?: (cp: Record<string, unknown>) => Promise<void>;
    sleep?: (ms: number) => Promise<void>;
    pollBudgetMs?: number;
  } = {},
) {
  if (!c.providerContractConfirmed)
    throw new ProviderError(
      "Confirm the Eloqua activity fields and permissions for this tenant before connecting",
    );
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...eloquaAuth(c, secrets),
  };
  const { base, site } = await discoverBase(
    cfg,
    headers,
    c.discoveryUrl || undefined,
  );
  if (opts.checkOnly) {
    const { body } = await json(
      `${base}/api/REST/2.0/assets/campaigns?depth=minimal&count=1&page=1`,
      cfg,
      { headers },
    );
    return {
      records: [] as RecordData[],
      capabilities: {
        authentication: { state: "available", site },
        campaigns: { state: "available", total: body?.total ?? null },
        activities: {
          state: "not_checked",
          note: "Bulk exports are tested by a sync",
        },
      },
      asOf: new Date().toISOString(),
      metadata: { transport: "eloqua-bulk", base },
    };
  }
  const now = new Date();
  const st: BulkState = (opts.checkpoint?.eloqua as BulkState) || {
    types: (c.activityTypes.length
      ? c.activityTypes
      : [...ELOQUA_ACTIVITY_TYPES]
    ).map((type) => ({ type })),
    owned: [],
    since: new Date(now.getTime() - c.backfillDays * 86_400_000).toISOString(),
    until: now.toISOString(),
    startedAt: now.toISOString(),
  };
  const save = async () => opts.saveCheckpoint?.({ eloqua: st });
  const sleep =
    opts.sleep || ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (opts.pollBudgetMs ?? 120_000);
  // 1) define exports and start syncs (recorded before polling so a crash never duplicates them)
  for (const t of st.types) {
    if (!t.exportUri) {
      const fields =
        c.activityFieldMaps[t.type] || DEFAULT_ACTIVITY_FIELDS[t.type];
      if (!fields)
        throw new ProviderError(
          `No verified field map for activity type ${t.type}`,
        );
      const { body } = await json(
        `${base}/api/bulk/2.0/activities/exports`,
        cfg,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: `oracle-ai-platform ${t.type} ${st.startedAt}`,
            fields,
            filter: `'{{Activity.Type}}'='${t.type}' AND '{{Activity.CreatedAt}}'>='${st.since.slice(0, 19)}' AND '{{Activity.CreatedAt}}'<'${st.until.slice(0, 19)}'`,
          }),
        },
      );
      if (!body?.uri)
        throw new ProviderError(
          "Eloqua did not return an export definition URI",
        );
      t.exportUri = String(body.uri);
      st.owned.push(t.exportUri);
      await save();
    }
    if (!t.syncUri) {
      const { body } = await json(`${base}/api/bulk/2.0/syncs`, cfg, {
        method: "POST",
        headers,
        body: JSON.stringify({ syncedInstanceUri: t.exportUri }),
      });
      if (!body?.uri)
        throw new ProviderError("Eloqua did not return a sync URI");
      t.syncUri = String(body.uri);
      t.status = String(body.status || "pending");
      await save();
    }
  }
  // 2) poll within this run's budget, then hand back to the durable queue
  for (const t of st.types) {
    while (!["success", "warning", "error"].includes(String(t.status))) {
      const { body } = await json(`${base}/api/bulk/2.0${t.syncUri}`, cfg, {
        headers,
      });
      t.status = String(body?.status || "");
      if (["success", "warning", "error"].includes(t.status)) break;
      if (!["pending", "active"].includes(t.status))
        throw new ProviderError(`Unexpected Eloqua sync status ${t.status}`);
      if (Date.now() > deadline) {
        await save();
        throw new PendingExport({ eloqua: st });
      }
      await sleep(5000);
    }
    if (t.status === "error")
      throw new ProviderError(
        `Eloqua sync for ${t.type} failed; review its sync log in Eloqua`,
      );
  }
  // 3) retrieve every page (complete only when hasMore is false)
  const raw: any[] = [];
  const warnings: string[] = [];
  for (const t of st.types) {
    if (t.status === "warning")
      warnings.push(
        `${t.type} sync completed with warnings; the snapshot is marked partial.`,
      );
    for (let offset = 0, pages = 0; ; pages++) {
      if (pages > 100)
        throw new ProviderError("Activity retrieval exceeded 100 pages");
      const { body } = await json(
        `${base}/api/bulk/2.0${t.syncUri}/data?offset=${offset}&limit=${PAGE}`,
        cfg,
        { headers },
      );
      if (typeof body?.hasMore !== "boolean")
        throw new ProviderError(
          "Eloqua data page is missing hasMore; completeness cannot be confirmed",
        );
      const items = Array.isArray(body.items) ? body.items : [];
      if (body.hasMore && !items.length)
        throw new ProviderError(
          "Eloqua reported more rows but returned an empty page",
        );
      for (const it of items)
        raw.push({ ...it, type: "activity", activityType: t.type });
      if (raw.length > MAX_ROWS)
        throw new ProviderError(
          `Activity export exceeds ${MAX_ROWS} rows; reduce backfillDays or activity types`,
        );
      if (!body.hasMore) break;
      offset += items.length;
    }
  }
  const campaigns = await readCampaigns(base, cfg, headers);
  // Normalize Eloqua timestamps ("2026-10-01 10:00:00.000" in the tenant timezone) only when the
  // configured timezone offset is known; otherwise refuse rather than guess.
  for (const r of raw) {
    const v = String(r.activityDate ?? "");
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(v)) {
      if (!c.timestampOffset)
        throw new ProviderError(
          "Set the Eloqua timestamp offset (e.g. +00:00) to interpret activity times",
        );
      r.activityDate =
        v.replace(" ", "T").replace(/\.\d+$/, "") + c.timestampOffset;
    }
  }
  // Stable de-duplication across overlapping look-back windows: one row per activity type + ID.
  const unique = [
    ...new Map(
      raw.map((r) => [
        r.activityType + ":" + r.id,
        { ...r, id: r.activityType + ":" + r.id },
      ]),
    ).values(),
  ];
  const checked = validateRecords("eloqua", [...campaigns, ...unique]);
  if (checked.errors.length)
    throw new ProviderError(
      `Eloqua row ${checked.errors[0].row} failed validation: ${checked.errors[0].message}`,
    );
  // 4) clean up only resources this connector created
  const cleaned: string[] = [];
  for (const uri of st.owned)
    try {
      await request(`${base}/api/bulk/2.0${uri}`, cfg, {
        method: "DELETE",
        headers,
      });
      cleaned.push(uri);
    } catch {
      /* left listed in metadata for administrator follow-up */
    }
  return {
    records: checked.records,
    capabilities: {
      authentication: { state: "available", site },
      campaigns: { state: "available", rows: campaigns.length },
      activities: {
        state: warnings.length ? "partial" : "available",
        rows: unique.length,
        types: st.types.map((t) => t.type),
      },
    },
    asOf: st.until,
    metadata: {
      transport: "eloqua-bulk",
      base,
      window: { since: st.since, until: st.until },
      completeness: warnings.length ? "partial" : "complete",
      warnings,
      ownedResources: st.owned,
      cleanedResources: cleaned,
      dedupe: "activityType + Activity.Id",
      note: "Activity created in the look-back window after the export can appear in a later sync; each sync replaces the window.",
    },
  };
}
