import { parse } from "csv-parse/sync";
import Decimal from "decimal.js";
import {
  ENTITY_TYPES,
  type AppId,
  type RecordData,
  type Source,
} from "../shared/catalog";
import { DICTIONARY, fieldType } from "../shared/fields";
import { HttpError, id, hash, audit } from "./security";
import type { Database } from "./db";
import { moduleFor } from "./modules";
export interface ImportFile {
  content: string;
  format: "csv" | "json";
  type: string;
  mapping?: Record<string, string>;
  name?: string;
}
export interface ImportInput extends ImportFile {
  name: string;
  asOf: string;
  coverageStart?: string;
  coverageEnd?: string;
}
export interface RowError {
  row: number;
  message: string;
  file?: string;
  column?: string;
}
// Object-prototype names are never valid field names; rejecting them keeps
// parsed rows and stored JSON free of prototype-replacement keys.
const RESERVED_FIELDS = new Set(["__proto__", "constructor", "prototype"]);
const reservedField = (names: string[]) =>
  names.find((n) =>
    RESERVED_FIELDS.has(
      String(n)
        .trim()
        .replace(/^"(.*)"$/, "$1"),
    ),
  );
export const MAX_FILE_BYTES = 4_000_000;
export const MAX_ROWS = 25_000;
export const MAX_FILES = 10;
function rawRows(input: ImportFile): any[] {
  if (input.content.length > MAX_FILE_BYTES)
    throw new HttpError(413, "File exceeds the 4 MB upload limit");
  if (
    input.format !== "json" &&
    reservedField(input.content.split(/\r?\n/, 1)[0].split(","))
  )
    throw new HttpError(
      422,
      "Rename the column __proto__, constructor or prototype; these names are reserved.",
    );
  let raw: any[];
  try {
    const parsed =
      input.format === "json"
        ? JSON.parse(input.content)
        : parse(input.content, {
            columns: (header: string[]) => {
              if (reservedField(header)) throw Error("Reserved column name");
              return header;
            },
            bom: true,
            skip_empty_lines: true,
            trim: true,
            max_record_size: 100000,
          });
    raw = Array.isArray(parsed) ? parsed : parsed.records;
    if (!Array.isArray(raw)) throw Error("Expected records array");
  } catch {
    throw new HttpError(
      422,
      `Cannot parse ${input.name || "this file"}. Use CSV with a header row or a JSON array.`,
    );
  }
  if (raw.length > MAX_ROWS)
    throw new HttpError(
      422,
      `Split ${input.name || "this file"} into at most ${MAX_ROWS} records per upload`,
    );
  return raw;
}
export function parseImport(app: AppId, input: ImportFile) {
  return validateRecords(app, rawRows(input), input.type, input.mapping);
}
const ISO =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
function normalize(entity: string, k: string, v: unknown): unknown {
  const t = fieldType(entity, k);
  if (t === null) {
    if (typeof v === "string" && v.length > 20000)
      throw Error(`${k} exceeds the field length limit`);
    return v;
  }
  const s = typeof v === "string" ? v.trim() : v;
  switch (t) {
    case "id": {
      const x = String(s);
      if (x.length > 200) throw Error(`${k} exceeds 200 characters`);
      return x;
    }
    case "count":
    case "decimal": {
      let n: Decimal;
      try {
        n = new Decimal(String(s));
      } catch {
        throw Error(`${k} must be a number`);
      }
      if (!n.isFinite()) throw Error(`${k} must be finite`);
      if (t === "count" && (n.lt(0) || !n.isInteger()))
        throw Error(`${k} must be a whole number of 0 or more`);
      return n.toString();
    }
    case "date": {
      const x = String(s);
      if (
        !ISO.test(x) ||
        Number.isNaN(Date.parse(x)) ||
        new Date(x.slice(0, 10) + "T00:00:00Z").toISOString().slice(0, 10) !==
          x.slice(0, 10)
      )
        throw Error(
          `${k} must be an unambiguous ISO date (YYYY-MM-DD) or timestamp with timezone`,
        );
      if (x.length > 10 && !/(Z|[+-]\d{2}:\d{2})$/.test(x))
        throw Error(`${k} timestamp needs a timezone (Z or ±hh:mm)`);
      return x;
    }
    case "boolean": {
      const x = String(s).toLowerCase();
      if (["true", "yes", "1", "y"].includes(x)) return true;
      if (["false", "no", "0", "n"].includes(x)) return false;
      throw Error(`${k} must be true or false`);
    }
    case "list":
      return Array.isArray(s) ? s.map(String).join(";") : String(s);
    default: {
      const x = String(s);
      if (x.length > 20000) throw Error(`${k} exceeds the field length limit`);
      return x;
    }
  }
}
export function validateRecords(
  app: AppId,
  raw: any[],
  type?: string,
  mapping: Record<string, string> = {},
) {
  const records: RecordData[] = [],
    errors: RowError[] = [],
    seen = new Set<string>();
  raw.forEach((r, i) => {
    try {
      if (!r || typeof r !== "object" || Array.isArray(r))
        throw Error("Expected an object");
      const reserved = reservedField([
        ...Object.keys(r),
        ...Object.keys(mapping),
        ...Object.values(mapping),
      ]);
      if (reserved)
        throw Error(`Rename the field ${reserved}; this name is reserved`);
      const out: Record<string, unknown> = { ...r };
      for (const [k, v] of Object.entries(mapping)) if (v) out[k] = r[v];
      out.type = type && type !== "mixed" ? type : String(out.type || "");
      const entity = String(out.type);
      if (!ENTITY_TYPES[app].includes(entity))
        throw Error(
          `Choose a supported ${app} data type or include a type column (${ENTITY_TYPES[app].join(", ")})`,
        );
      for (const [k, v] of Object.entries(out)) {
        if (k === "type") continue;
        if (v === "" || v === undefined || v === null) {
          out[k] = null;
          continue;
        }
        out[k] = normalize(entity, k, v);
      }
      for (const fd of DICTIONARY[entity])
        if (
          fd.required &&
          (out[fd.name] === null || out[fd.name] === undefined)
        )
          throw Error(`${fd.name} is required for ${entity}`);
      const key = entity + ":" + out.id;
      if (seen.has(key))
        throw Error(`Duplicate ${entity} ID ${String(out.id)} in this upload`);
      seen.add(key);
      records.push(out as RecordData);
    } catch (e) {
      if (errors.length < 200)
        errors.push({ row: i + 1, message: (e as Error).message });
    }
  });
  return {
    records,
    errors,
    headers: raw[0] ? Object.keys(raw[0]) : [],
    total: raw.length,
    valid: records.length,
  };
}
/** Validate several related files as one explicit batch (one immutable snapshot). */
export function parseBatch(app: AppId, files: ImportFile[]) {
  if (!files.length) throw new HttpError(422, "Add at least one file");
  if (files.length > MAX_FILES)
    throw new HttpError(422, `A batch can contain at most ${MAX_FILES} files`);
  const all: RecordData[] = [],
    origin: { file: string; row: number }[] = [],
    errors: RowError[] = [],
    perFile: {
      name: string;
      type: string;
      total: number;
      valid: number;
      headers: string[];
      sha256: string;
    }[] = [];
  let total = 0;
  for (const [n, f] of files.entries()) {
    const name = f.name || `file ${n + 1}`;
    const raw = rawRows({ ...f, name });
    total += raw.length;
    const v = validateRecords(app, raw, f.type, f.mapping);
    errors.push(...v.errors.map((e) => ({ ...e, file: name })));
    perFile.push({
      name,
      type: f.type,
      total: v.total,
      valid: v.valid,
      headers: v.headers,
      sha256: hash(f.content),
    });
    // Keep origin of each valid record for cross-file messages.
    let row = 0;
    for (const r of v.records) {
      while (v.errors.some((e) => e.row === row + 1)) row++;
      origin.push({ file: name, row: ++row });
      all.push(r);
    }
  }
  if (all.length + errors.length > MAX_ROWS)
    throw new HttpError(422, `A batch can contain at most ${MAX_ROWS} records`);
  const seen = new Map<string, number>();
  const records: RecordData[] = [],
    kept: { file: string; row: number }[] = [];
  all.forEach((r, i) => {
    const k = r.type + ":" + r.id;
    if (seen.has(k)) {
      errors.push({
        ...origin[i],
        message: `Duplicate ${r.type} ID ${r.id}: also in ${origin[seen.get(k)!].file}. Files in one batch must not overlap.`,
      });
      return;
    }
    seen.set(k, i);
    records.push(r);
    kept.push(origin[i]);
  });
  const check = moduleFor(app).validateBatch(records);
  for (const e of check.errors)
    errors.push(
      e.row > 0 && kept[e.row - 1]
        ? { ...kept[e.row - 1], message: e.message }
        : { row: 0, file: "batch", message: e.message },
    );
  const invalid = new Set(
    check.errors.filter((e) => e.row > 0).map((e) => e.row - 1),
  );
  return {
    records: records.filter((_, i) => !invalid.has(i)),
    errors,
    warnings: check.warnings,
    files: perFile,
    total,
    valid: records.length - invalid.size,
  };
}
export async function commitRecords(
  db: Database,
  workspace: string,
  user: string,
  source: Source,
  records: RecordData[],
  meta: {
    name: string;
    mode: "upload" | "connected" | "stream";
    asOf: string;
    coverageStart?: string;
    coverageEnd?: string;
    metadata?: unknown;
    jobId?: string;
    jobAttempt?: number;
  },
) {
  if (!records.length && meta.mode === "upload")
    throw new HttpError(422, "No records to import");
  if (Number.isNaN(Date.parse(meta.asOf)))
    throw new HttpError(422, "Source as-of date is required");
  const fingerprint = hash(
    JSON.stringify({
      records,
      asOf: meta.asOf,
      mode: meta.mode,
      coverageStart: meta.coverageStart,
      coverageEnd: meta.coverageEnd,
    }),
  );
  return db.tenant(workspace, async (tx) => {
    await tx.query(
      "SELECT id FROM sources WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
      [source.id, workspace],
    );
    if (meta.jobId) {
      const job = await tx.query(
        "SELECT state,attempts FROM jobs WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
        [meta.jobId, workspace],
      );
      if (
        job.rows[0]?.state !== "running" ||
        (meta.jobAttempt !== undefined &&
          job.rows[0]?.attempts !== meta.jobAttempt)
      )
        throw new HttpError(409, "Job was cancelled or its lease ended");
    }
    const existing = await tx.query(
      "SELECT id FROM datasets WHERE source_id=$1 AND fingerprint=$2",
      [source.id, fingerprint],
    );
    if (existing.rows[0]) return { id: existing.rows[0].id, duplicate: true };
    const datasetId = id();
    await tx.query(
      "INSERT INTO datasets(id,workspace_id,source_id,name,mode,fingerprint,as_of,coverage_start,coverage_end,row_count,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        datasetId,
        workspace,
        source.id,
        meta.name,
        meta.mode,
        fingerprint,
        meta.asOf,
        meta.coverageStart || null,
        meta.coverageEnd || null,
        records.length,
        JSON.stringify(meta.metadata || {}),
      ],
    );
    for (let offset = 0; offset < records.length; offset += 500) {
      const chunk = records.slice(offset, offset + 500);
      await tx.query(
        `INSERT INTO ${source.app}_records(workspace_id,dataset_id,source_id,external_id,entity_type,data) SELECT $1,$2,$3,x->>'id',x->>'type',x FROM jsonb_array_elements($4::jsonb) x`,
        [workspace, datasetId, source.id, JSON.stringify(chunk)],
      );
    }
    await tx.query("UPDATE datasets SET active=false WHERE source_id=$1", [
      source.id,
    ]);
    await tx.query("UPDATE datasets SET active=true WHERE id=$1", [datasetId]);
    await audit(tx, workspace, user, "dataset.activated", datasetId, {
      count: records.length,
      mode: meta.mode,
    });
    return { id: datasetId, duplicate: false };
  });
}
