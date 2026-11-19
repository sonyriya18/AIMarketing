# Operations: deployment, worker, storage, migrations, monitoring, retention, backup

## Topology
- One web process (`npm start` / `node dist-server/index.js`) behind the customer's TLS reverse proxy.
- One persistent worker (`npm run worker`) for jobs, Eloqua Bulk polling, Infinity streams and scheduled digests. Short-lived serverless functions are not suitable for the worker.
- A managed PostgreSQL database, separate from Responsys.
- `compose.yaml` and `Dockerfile` are provided. The production image contains no synthetic examples, and the examples endpoint is disabled in production.

## Database and migrations
1. Create the database.
2. Use an owner/migration login with `CREATEROLE` for the first provisioning only.
3. Run `DATABASE_MIGRATION_URL=… RUNTIME_DATABASE_PASSWORD=… npm run db:migrate`. This creates the schema, enables row-level security on 22 tenant tables, and creates and grants the non-owner `NOBYPASSRLS` runtime role.
4. Point `DATABASE_URL` at the runtime role, and remove the migration URL from web and worker. Production refuses to start with it.
5. Run `npm run verify:production`.

**Rollback.**
- The schema uses `CREATE … IF NOT EXISTS` (additive), so rolling back the app means redeploying the previous image against the same database.
- For destructive schema changes in future versions, take a backup first (see below) and restore it into a new database if needed.

## Monitoring and incidents
- Health endpoints: `/health/live` and `/health/ready`.
- Every API response carries an `X-Request-Id`, and server logs include it with redacted errors.
- Alert on:
  - failed jobs (`jobs.state='failed'`);
  - connections with an old `last_success_at`;
  - AI fallback rate (`/api/ai/usage`).
- **Incident runbook.**
  1. Check `/health/ready`.
  2. Check the worker process.
  3. Read the job's `failed_stage` and `last_error` in Data & connections.
  4. Check whether provider credentials rotated (re-enter them under "Rotate credentials").
  5. Check whether `OUTBOUND_HOSTS` changed.
  6. Re-run the sync. Datasets only activate after a complete extraction, so a failed sync never replaces the last good snapshot.

## Retention and deletion
- `npm run retention` previews; `npm run retention -- --apply` deletes:
  - AI conversation logs older than `RETENTION_DAYS`;
  - unsaved report views that nothing refers to;
  - unreferenced inactive datasets;
  - old finished jobs, stream staging rows, and expired sessions and login states.

  Saved reports, and anything an action, draft, investigation, scenario, feedback or schedule refers to, are kept.
- **Authorized deletion** (administrator, Data & connections → Delete):
  - deletes the dataset's imported records;
  - redacts every report built from it (it then returns HTTP 410);
  - removes the questions and answers of AI runs on those reports;
  - keeps audit metadata without the content.
- Deleted data remains in database backups until those backups expire under the customer's backup retention schedule. Document that schedule (for example 30 days of point-in-time recovery).

## Backup and restore
- Use managed PostgreSQL point-in-time recovery or `pg_dump -Fc`.
- **Restore drill.**
  1. `pg_restore` into a new database.
  2. Compare row counts per table.
  3. Confirm 22 tenant policies with RLS enabled.
  4. Run `TEST_DATABASE_URL=<runtime role on the restored db> npx vitest run tests/postgres-rls.test.ts`.
- This drill passed locally on PostgreSQL 16 (see `IMPLEMENTATION_STATUS.md`). It has not been run against a managed service.
