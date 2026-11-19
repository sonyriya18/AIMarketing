/**
 * Local administration of workspace roles (`npm run roles`), for recovering access on your own
 * machine — for example when the only owner was changed to another role.
 *
 *   npm run roles                         list every workspace member and role
 *   npm run roles -- owner you@mail.com   make that person an owner in every workspace they belong to
 *
 * Uses DATABASE_MIGRATION_URL from .env.local (the local database owner). Every change is written
 * to the audit history. Refuses to run with NODE_ENV=production.
 */
import { existsSync, readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import pg from 'pg';

const ROLES = ['viewer', 'analyst', 'marketer', 'approver', 'owner'];

async function main() {
  const env = { ...(existsSync('.env.local') ? dotenv.parse(readFileSync('.env.local')) : {}), ...process.env };
  if (env.NODE_ENV === 'production') {
    console.error('This is a local recovery tool; it does not run in production.');
    process.exit(1);
  }
  const url = env.DATABASE_MIGRATION_URL;
  if (!url) {
    console.error('DATABASE_MIGRATION_URL is not set. Run this in the project folder after npm run setup:local.');
    process.exit(1);
  }
  const [cmd, email] = process.argv.slice(2);
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    if (cmd && ROLES.includes(cmd)) {
      if (!email) throw new Error(`Usage: npm run roles -- ${cmd} someone@example.com`);
      const user = await db.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
      if (!user.rows[0]) throw new Error(`No user with email ${email}. Sign in once with that email first.`);
      await db.query('BEGIN');
      const changed = await db.query<{ workspace_id: string; old_role: string }>(
        `UPDATE memberships m SET role = $2 FROM (SELECT workspace_id, user_id, role AS old_role FROM memberships WHERE user_id = $1) o
          WHERE m.workspace_id = o.workspace_id AND m.user_id = o.user_id RETURNING m.workspace_id, o.old_role`,
        [user.rows[0].id, cmd]
      );
      for (const r of changed.rows) {
        await db.query(
          `INSERT INTO audit_events (workspace_id, actor_user_id, action, target_type, target_id, outcome, details) VALUES ($1, NULL, 'membership.local_admin_set_role', 'user', $2, 'success', $3)`,
          [r.workspace_id, user.rows[0].id, JSON.stringify({ from: r.old_role, to: cmd, via: 'npm run roles' })]
        );
      }
      await db.query('COMMIT');
      if (!changed.rowCount) console.log(`${email} is not a member of any workspace.`);
      else console.log(`${email} is now ${cmd} in ${changed.rowCount} workspace(s). Sign out and sign in again in the app.`);
    } else if (cmd) {
      throw new Error(`Unknown command "${cmd}". Use one of: ${ROLES.join(', ')} — or no argument to list members.`);
    }
    const rows = await db.query<{ workspace: string; email: string; role: string }>(
      `SELECT w.name AS workspace, u.email, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id JOIN users u ON u.id = m.user_id ORDER BY w.created_at, m.role DESC, u.email`
    );
    console.log('\nWorkspace members:\n');
    for (const r of rows.rows) console.log(`  ${r.workspace.padEnd(28)} ${r.email.padEnd(36)} ${r.role}`);
    const noOwner = await db.query<{ name: string }>(`SELECT w.name FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id = w.id AND m.role = 'owner')`);
    for (const w of noOwner.rows) console.log(`\n  ! Workspace "${w.name}" has no owner. Fix with: npm run roles -- owner your@email`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => undefined);
    console.error((e as Error).message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}

void main();
