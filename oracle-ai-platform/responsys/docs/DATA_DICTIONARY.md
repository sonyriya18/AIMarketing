# Data dictionary

Definitions version: `metrics-2026-10-15.1` (`shared/metrics/registry.ts`). Every report snapshot
records the definitions version it used. Values are computed with exact decimals; a missing
numerator or denominator gives **Unavailable** (with a reason), never zero.

## Base measures (counts and money)

| ID | Label | Meaning |
|---|---|---|
| `sent` | Sent | Messages the source reports as sent |
| `delivered` | Delivered | Accepted by the receiving system (not inbox placement) |
| `skipped` | Skipped | Messages the source reports as skipped |
| `bounces` | Bounces | Bounced messages |
| `total_opens` | Total opens | All open events, including repeats |
| `unique_opens` | Unique opens | Source-defined unique opens |
| `total_clicks` | Total clicks | All click events, including repeats |
| `unique_clicks` | Unique clicks | Source-defined unique clicks (may be link-unique) |
| `conversion_events` | Conversion events | Attributed conversion events — not necessarily orders |
| `orders` | Orders | Only when the source states orders explicitly |
| `revenue` | Attributed revenue | Provider-attributed; not incremental or accounting revenue |
| `unsubscribes` | Unsubscribes | Opt-outs attributed to the messages |
| `complaints` | Complaints | Spam complaints |

## Rates (always recomputed from summed numerators and denominators)

| ID | Formula |
|---|---|
| `delivered_rate` | delivered / sent × 100 |
| `bounce_rate` | bounces / sent × 100 |
| `total_open_rate` | total opens / delivered × 100 (can exceed 100%) |
| `unique_open_rate` | unique opens / delivered × 100 |
| `total_click_rate` | total clicks / delivered × 100 (can exceed 100%) |
| `unique_click_rate` | unique clicks / delivered × 100 |
| `unique_click_to_open_rate` | unique clicks / unique opens × 100 |
| `conversion_event_rate` | conversion events / delivered × 100 (events, not people) |
| `unsubscribe_rate` | unsubscribes / delivered × 100 |
| `complaint_rate` | complaints / delivered × 100 |
| `revenue_per_delivered` | revenue / delivered |
| `revenue_per_1000_delivered` | revenue / delivered × 1000 |
| `average_order_value` | revenue / orders (needs an orders column) |

Changes are shown as percentage points (pp) for rates and as absolute + relative change for
counts and money. Rates are never averaged across rows.

## Import format A — campaign metrics (recommended)

One row per campaign launch (optionally per activity date). Headers are matched case- and
punctuation-insensitively. Required: a campaign ID and a launch date (or activity date).

| Field | Accepted headers |
|---|---|
| Campaign ID | Campaign ID, Campaign External ID, External Campaign ID |
| Campaign name | Campaign Name, Name |
| Launch ID | Launch ID |
| Channel | Channel |
| Launch date | Launch Date, Send Date, Sent Date |
| Launch time (optional) | Launch Time, Send Time, Sent Time — HH:mm or HH:mm:ss in the confirmed account timezone |
| Activity date | Activity Date, Event Date, Report Date |
| Program / subject | Program, Program Name / Subject Line, Subject |
| Creative type (optional) | Creative Type, Content Type, Creative, Creative Format, Template Type, Layout |
| Offer (optional) | Offer, Offer Type, Offer Name, Incentive, Promotion, Promo Type, Discount |
| Currency | Currency, Currency Code |
| Counts | Sent, Delivered, Skipped, Bounces, Total Opens, Unique Opens, Opens*, Total Clicks, Unique Clicks, Clicks*, Conversions, Orders, Revenue, Unsubscribes, Complaints |

Subject Line, Creative Type and Offer are kept as written (trimmed). The Summary groups results by
each value in sections 6 (Content) and 8 (Offer); rows without a value are reported as "not given"
and never assigned a value.

\* A bare "Opens"/"Clicks" column is ambiguous; the wizard asks whether it is total or unique.

Example (this is `tests/fixtures/golden-campaigns.csv`):

```csv
Campaign ID,Campaign Name,Launch ID,Channel,Launch Date,Sent,Delivered,Bounces,Total Opens,Total Clicks,Conversions,Revenue,Unsubscribes
TEST-CAMP-A,Test campaign A,L-A1,Email,2026-10-01,1020,1000,20,100,20,5,500.00,1
TEST-CAMP-B,Test campaign B,L-B1,Email,2026-10-02,9180,9000,180,2700,450,90,9000.00,9
```

Before activation the user must confirm: the timezone of the dates, the currency, and whether
the file covers the whole account for its dates (coverage).

## Import format B — legacy account summary

One row per channel and "Sent Date Range" (e.g. "Last 7 Days"). It holds rates as reported, not
numerators. It establishes **account-period totals only** — no campaigns, recipients, segments
or hours. Source rates are shown in a separate "Rates as reported in the export" section and are
not mixed with recomputed rates. The window end date must be confirmed by the user.

## Grain and limits

- Campaign file: campaign × launch (× activity date). Daily trend is by launch date (send cohort).
- Legacy summary: account × channel × window. Nested windows are differenced ("2N − N") only when
  both windows exist; otherwise the comparison is unavailable.
- Hourly launch analysis requires Launch Time in a campaign export. Date-only exports support launch-weekday analysis; account-summary exports support neither. These are send-cohort outcomes, not recipients' event-open times.
- Not available from either format: recipient behaviour, segments, link placement,
  mailbox domains. Screens list these under "What this data cannot show".

## Responsys mappings

- Connect job runs → `connect_job_runs` (status, start/end, counts as returned).
- Async performance reporting → campaign facts **only** after the result row schema is confirmed
  against a real response. Unknown shapes are rejected and reported, not guessed.
