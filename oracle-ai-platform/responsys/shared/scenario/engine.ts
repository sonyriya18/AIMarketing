/**
 * Transparent planning scenario (blueprint section 13). Deterministic and versioned.
 *
 * It answers "what would happen under these explicit assumptions?" — it is not a forecast,
 * causal estimate, or confidence interval. Low/base/high are user assumption ranges.
 *
 *   expected_delivered  = eligible_audience × delivery_probability
 *   expected_converters = expected_delivered × conversion_probability
 *   expected_orders     = expected_converters × orders_per_converter
 *   expected_revenue    = expected_orders × net_order_value
 *   contribution        = expected_revenue − orders × variable_cost_per_order − campaign_cost
 *   incremental_revenue = scenario revenue − revenue with the baseline conversion probability
 */
import Decimal from 'decimal.js';
import { z } from 'zod';

export const SCENARIO_ALGORITHM = 'planning-scenario-2026-10-15.1';

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });
const dec = z.string().regex(/^\d+(\.\d+)?$/, 'Use a non-negative decimal number');

const Input = z.object({
  low: dec,
  base: dec,
  high: dec,
  source: z.string().max(80).default('user_assumption'),
  note: z.string().max(300).optional(),
});
const OptionalInput = Input.nullable().default(null);

export const ScenarioInputsSchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    eligibleAudience: Input,
    deliveryProbability: Input,
    conversionProbability: Input,
    ordersPerConverter: Input,
    netOrderValue: Input,
    variableCostPerOrder: OptionalInput,
    campaignCost: OptionalInput,
    baselineConversionProbability: OptionalInput,
    launchSchedule: z.object({
      weekday: z.number().int().min(1).max(7).nullable(), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
      timezone: z.string().max(120), basis: z.enum(['hour', 'weekday', 'baseline']),
      expectedOpenRate: z.number().nonnegative().nullable(), expectedClickRate: z.number().nonnegative().nullable(),
    }).optional(),
  })
  .superRefine((v, ctx) => {
    const entries = Object.entries(v).filter(([k, x]) => !['currency', 'launchSchedule'].includes(k) && x) as [string, z.infer<typeof Input>][];
    for (const [k, x] of entries) {
      if (new D(x.low).gt(x.base) || new D(x.base).gt(x.high)) ctx.addIssue({ code: 'custom', path: [k], message: 'Low ≤ base ≤ high is required' });
      if (/Probability$/.test(k) && new D(x.high).gt(1)) ctx.addIssue({ code: 'custom', path: [k], message: 'A probability per recipient must be between 0 and 1' });
    }
    if (!/^\d+$/.test(v.eligibleAudience.base) || !/^\d+$/.test(v.eligibleAudience.low) || !/^\d+$/.test(v.eligibleAudience.high)) {
      ctx.addIssue({ code: 'custom', path: ['eligibleAudience'], message: 'Audience counts are whole numbers' });
    }
  });
export type ScenarioInputs = z.infer<typeof ScenarioInputsSchema>;

type Case = 'low' | 'base' | 'high';
const KEYS = ['eligibleAudience', 'deliveryProbability', 'conversionProbability', 'ordersPerConverter', 'netOrderValue', 'variableCostPerOrder', 'campaignCost', 'baselineConversionProbability'] as const;
type Key = (typeof KEYS)[number];

const s = (d: Decimal, dp = 4) => {
  const t = d.toDecimalPlaces(dp).toFixed();
  return t.includes('.') ? t.replace(/0+$/, '').replace(/\.$/, '') : t;
};

export interface ScenarioCaseOutput {
  expectedDelivered: string;
  expectedConverters: string;
  expectedOrders: string;
  expectedRevenue: string;
  contribution: string | null;
  incrementalRevenue: string | null;
}

function compute(values: Record<Key, Decimal | null>): ScenarioCaseOutput {
  const delivered = values.eligibleAudience!.mul(values.deliveryProbability!);
  const converters = delivered.mul(values.conversionProbability!);
  const orders = converters.mul(values.ordersPerConverter!);
  const revenue = orders.mul(values.netOrderValue!);
  const contribution =
    values.variableCostPerOrder === null || values.campaignCost === null ? null : revenue.minus(orders.mul(values.variableCostPerOrder)).minus(values.campaignCost);
  const baseRevenue =
    values.baselineConversionProbability === null ? null : delivered.mul(values.baselineConversionProbability).mul(values.ordersPerConverter!).mul(values.netOrderValue!);
  return {
    expectedDelivered: s(delivered, 2),
    expectedConverters: s(converters, 2),
    expectedOrders: s(orders, 2),
    expectedRevenue: s(revenue, 2),
    contribution: contribution === null ? null : s(contribution, 2),
    incrementalRevenue: baseRevenue === null ? null : s(revenue.minus(baseRevenue), 2),
  };
}

function pick(inputs: ScenarioInputs, c: Case): Record<Key, Decimal | null> {
  const out = {} as Record<Key, Decimal | null>;
  for (const k of KEYS) {
    const x = inputs[k] as z.infer<typeof Input> | null;
    out[k] = x ? new D(x[c]) : null;
  }
  return out;
}

export interface ScenarioOutput {
  algorithmVersion: string;
  label: 'SCENARIO — assumption-based projection, not measured results';
  currency: string;
  cases: Record<Case, ScenarioCaseOutput>;
  sensitivity: { input: Key; lowRevenue: string; highRevenue: string; swing: string }[];
  assumptions: { input: Key; low: string; base: string; high: string; source: string; note: string | null }[];
  notes: string[];
}

export function runScenario(raw: ScenarioInputs): ScenarioOutput {
  const inputs = ScenarioInputsSchema.parse(raw);
  const cases = { low: compute(pick(inputs, 'low')), base: compute(pick(inputs, 'base')), high: compute(pick(inputs, 'high')) };
  const base = pick(inputs, 'base');
  const sensitivity = KEYS.filter((k) => inputs[k] && !['variableCostPerOrder', 'campaignCost', 'baselineConversionProbability'].includes(k))
    .map((k) => {
      const lo = compute({ ...base, [k]: new D((inputs[k] as { low: string }).low) });
      const hi = compute({ ...base, [k]: new D((inputs[k] as { high: string }).high) });
      return { input: k, lowRevenue: lo.expectedRevenue, highRevenue: hi.expectedRevenue, swing: s(new D(hi.expectedRevenue).minus(lo.expectedRevenue), 2) };
    })
    .sort((a, b) => new D(b.swing).cmp(a.swing));
  const notes = [
    'Low/base/high are ranges of your assumptions, not a statistical confidence interval.',
    'Conversion probability is per delivered recipient (one-order-per-converter model). A provider conversion-event rate is not a per-recipient probability.',
    'This projection does not establish that any change causes uplift; test changes with a controlled experiment.',
  ];
  if (inputs.launchSchedule) notes.splice(0, 1, 'Launch-time engagement estimates use historical associations. Conversion and order value are held at baseline; no uncertainty range or revenue uplift is assumed.');
  if (inputs.variableCostPerOrder === null || inputs.campaignCost === null) notes.push('Costs were not provided, so contribution is unavailable.');
  if (inputs.baselineConversionProbability === null) notes.push('No baseline conversion probability was provided, so incremental revenue is unavailable.');
  return {
    algorithmVersion: SCENARIO_ALGORITHM,
    label: 'SCENARIO — assumption-based projection, not measured results',
    currency: inputs.currency,
    cases,
    sensitivity,
    assumptions: KEYS.filter((k) => inputs[k]).map((k) => {
      const x = inputs[k] as z.infer<typeof Input>;
      return { input: k, low: x.low, base: x.base, high: x.high, source: x.source, note: x.note ?? null };
    }),
    notes,
  };
}
