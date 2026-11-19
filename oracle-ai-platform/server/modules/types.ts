import type { AppId, RecordData, Report, Source } from "../../shared/catalog";
import type { AssessmentMeta, RuleDef } from "./common";
import type { ModuleLayout } from "./layout";

export interface MetricDefinition {
  id: string;
  label: string;
  grain: string;
  basis: "unique" | "total" | "snapshot" | "derived";
  numerator: string;
  denominator: string | null;
  timeBasis: string;
  exclusions: string;
  source: string;
}
export interface ScenarioField {
  key: string;
  label: string;
  unit: "count" | "percent" | "money" | "text";
  prefill?: string;
  optional?: boolean;
}
export interface ScenarioResult {
  kind: "assumption";
  formulaVersion: string;
  formula: string;
  measured: Record<string, string | null>;
  assumed: Record<string, string>;
  projected: Record<string, string | null>;
  unit: string;
  note: string;
  currency?: string;
}
export interface CompareResult {
  columns: { key: string; label: string }[];
  rows: { metric: string; unit: string; values: (string | null)[] }[];
  caveats: string[];
  test: null | {
    metric: string;
    method: string;
    diffPp: number;
    pValue: number;
    conclusion: string;
  };
  extra?: {
    title: string;
    rows: { label: string; value: string | null; definition: string }[];
  }[];
}
export interface DraftType {
  id: string;
  label: string;
  fields: { key: string; label: string; multiline?: boolean }[];
  prefill: (report: Report, findingId?: string) => Record<string, string>;
}
export interface BatchCheck {
  errors: { row: number; message: string }[];
  warnings: string[];
}
export interface ModuleDefinition {
  app: AppId;
  definitionVersion: string;
  layout: ModuleLayout;
  rules: Record<string, RuleDef>;
  metricDictionary: MetricDefinition[];
  assess: (
    source: Source,
    records: RecordData[],
    meta: AssessmentMeta,
  ) => Report;
  select: (all: RecordData[], keys: string[]) => RecordData[];
  validateBatch: (records: RecordData[]) => BatchCheck;
  scenarioFields: ScenarioField[];
  simulate: (input: Record<string, unknown>) => ScenarioResult;
  compare: (
    source: Source,
    all: RecordData[],
    keys: string[],
    meta: AssessmentMeta,
  ) => CompareResult;
  draftTypes: DraftType[];
  compareEntity: string;
  analyzeEntity: string;
}
