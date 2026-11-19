# Oracle Unity connector setup

Status: **generic tenant-configured REST adapter, contract-tested with simulated responses. Not live verified.** Unity models, Customer 360 views and export mechanisms vary by deployment, so no Unity endpoint is pre-filled.

## What is supported

- **Authentication:**
  - Oracle's documented IDCS resource-owner password flow (`unity-password`: client ID/secret plus integration user), or
  - an administrator-managed bearer token, or
  - OAuth authorization code where the tenant supports it.
  Verify grants and roles with the tenant administrator. The connector never elevates access.
- **Reads:** administrator-entered resources (`type` = profile/consent/segment/membership/destination/job, `path`, `itemsPath`, pagination `offset` with `hasMore` or `next` links, field `mapping`). Pagination must be explicit: ambiguous completion, empty "more" pages, repeating cursors and cross-origin links all fail the sync.
- Segment and object exports can produce several output parts. Load them as one explicit **upload batch** (segments + memberships + profiles + consent + destinations) and mark `membershipComplete=true` only after confirming every part was collected.
- **SFTP export consumption is not implemented.**

## Setup steps

1. Ask the Unity administrator for:
   - tenant/access identifiers;
   - the deployed data model (objects and attributes) and the master ID field;
   - Customer 360 rule/view IDs if used;
   - the job/status read endpoint;
   - the authorized export method for profiles, segments and memberships.
2. Add the tenant host(s) to `OUTBOUND_HOSTS`.
3. Go to Unity → Data & connections → Add connection, then enter the resources and mappings exactly as documented for that tenant.
4. Set the source policy:
   - `requiredFields` for the purpose (for example the email destination);
   - `staleDays`;
   - `snapshotToleranceHours`.
5. Provide destination requirements: an upload of `destination` rows with required fields and the consent channel/purpose.

## Rules that are deliberately not automated

No merges, no identity-rule changes, no segment activation, and no re-running of production jobs as a reaction to an AI suggestion. A job-status API is not a substitute for profile or membership data.
