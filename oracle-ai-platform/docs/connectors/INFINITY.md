# Oracle Infinity connector setup

Status: **saved-report export and Streams consumer implemented, contract-tested with simulated responses. Not live verified.**

## Saved-report export (report mode)

- Start from the **generated export URL of an actual saved report**, using an account with access to the account, collection and report. A 404 can mean permission denied.
- The first request in a job adds `refresh=true`. Every later poll **omits it**, because repeated refresh can cancel the pending export (tested). Responses of 202 or "processing" re-queue the job with its checkpoint, and the job gives up after 30 minutes.
- Map rows to `report_row` (sessions, convertedSessions, dimension/dimensionValue, isTotal…). Upload a `report_manifest` (dates, timezone, sampled, truncated, rowsDisjoint) so totals are interpreted correctly. Without one, row totals are withheld.
- Report exports are reused for about two hours on Oracle's side. The platform records its own request time and never calls a report refresh a "stream".

## Streams (event mode)

- Infinity Streams is a live JSON WebSocket feed, **not** OCI Streaming and not a historical database. Configure the WSS URL, subscription message, items path and event mapping (id, sessionId, event, timestamp, plus optional visitorId and attributes) exactly from the account's Streams contract.
- The persistent worker reconnects with backoff, records receipt time separately from event time, de-duplicates by event ID, keeps a bounded window and publishes snapshots. Replay is **not** claimed: reconnects and gaps are recorded as coverage limitations.

## Setup steps

1. Add the Infinity API and stream hosts to `OUTBOUND_HOSTS`.
2. Go to Infinity → Data & connections → Add connection, choose the transport, and enter the export URL or the stream contract.
3. Set the policy:
   - `conversionEvent`;
   - `funnelSteps`, `funnelWindowMinutes`, `funnelIdentity`;
   - `lateMinutes`;
   - `minHistoryDays`.
4. Upload a `tracking_spec` (expected events and required attributes) to enable tracking-quality checks.
5. Reconcile one day's sessions against the native report under the same filters and timezone, then record the evidence.

## Website performance and time spent

There are two separate paths, never added together:

- **Events** (upload or connection):
  - Each event needs `sessionId`, `timestamp` and `page`.
  - Consecutive hits on the same page form one page view. If `pageViewEvent` is set, only events with that name count as page views.
  - **Time on page** is the time to the next page view. The last page of a session is not timed.
  - **Time spent** is last hit minus first hit. Single-hit sessions, and sessions with a gap above `sessionTimeoutMinutes`, are not measurable.
- **Saved page report** (`page_metrics` upload): one row per page (optionally per device) and period, with `pageViews`, `entries`, `exits`, `bounces`, `timeOnPageSeconds` and `timedPageViews`.

Policy settings and their defaults:

| Setting | Default |
|---|---|
| `webBounceThreshold` | 60% |
| `exitRateThreshold` | 60% |
| `lowTimeOnPageSeconds` | 10 |
| `sessionTimeoutMinutes` | 30 |
| `pageViewEvent` | Optional |
| `conversionEvent` | Enables the "engaged but not converting" check |
