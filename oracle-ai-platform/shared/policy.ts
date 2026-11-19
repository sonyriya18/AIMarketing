import { z } from "zod";
// Customer-approved assessment policy for one source account. Every rule threshold the
// assessment uses is listed here and shown in reports; defaults are published in
// docs/METRIC_DICTIONARY.md and can be changed by an administrator.
const pct = z.number().min(0).max(100);
const name = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/);
export const PolicySchema = z
  .object({
    // Shared
    staleDays: z.number().int().min(1).max(3650).optional(),
    minCohort: z.number().int().min(1).max(1_000_000).optional(),
    dropThreshold: pct.optional(),
    // Eloqua
    minSends: z.number().int().min(1).max(10_000_000).optional(),
    bounceRateThreshold: pct.optional(),
    unsubscribeRateThreshold: pct.optional(),
    ctorGapPp: pct.optional(),
    activityLookbackDays: z.number().int().min(0).max(90).optional(),
    attributionWindowDays: z.number().int().min(1).max(90).optional(),
    exposureMaxSends: z.number().int().min(1).max(1000).optional(),
    exposureWindowDays: z.number().int().min(1).max(365).optional(),
    deliveryFromBounces: z.boolean().optional(),
    excludeBotActivity: z.boolean().optional(),
    leadMaturityDays: z.number().int().min(0).max(365).optional(),
    staleLeadDays: z.number().int().min(1).max(365).optional(),
    mqlAcceptanceThreshold: pct.optional(),
    staleOpportunityDays: z.number().int().min(1).max(1095).optional(),
    eventAttendanceThreshold: pct.optional(),
    eventPipelineDays: z.number().int().min(1).max(365).optional(),
    knownVisitorThreshold: pct.optional(),
    shortVisitSeconds: z.number().int().min(1).max(3600).optional(),
    // Unity
    requiredFields: z.array(name).max(40).optional(),
    snapshotToleranceHours: z.number().min(0).max(720).optional(),
    // Infinity
    conversionEvent: z.string().min(1).max(100).optional(),
    funnelSteps: z.array(z.string().min(1).max(100)).min(2).max(10).optional(),
    funnelWindowMinutes: z.number().min(1).max(43200).optional(),
    funnelIdentity: z.enum(["session", "visitor"]).optional(),
    lateMinutes: z.number().int().min(1).max(10080).optional(),
    minHistoryDays: z.number().int().min(3).max(365).optional(),
    anomalyZ: z.number().min(1).max(10).optional(),
    pageViewEvent: z.string().min(1).max(100).optional(),
    webBounceThreshold: pct.optional(),
    exitRateThreshold: pct.optional(),
    lowTimeOnPageSeconds: z.number().int().min(1).max(3600).optional(),
    sessionTimeoutMinutes: z.number().int().min(1).max(1440).optional(),
  })
  .strict();
export type Policy = z.infer<typeof PolicySchema>;
