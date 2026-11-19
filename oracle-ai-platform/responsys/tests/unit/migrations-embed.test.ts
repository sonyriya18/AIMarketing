import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderEmbedded } from '../../scripts/embed-migrations';

describe('embedded migrations', () => {
  it('server/db/migrations.generated.ts matches the SQL files (run npm run db:embed)', async () => {
    expect(readFileSync('server/db/migrations.generated.ts', 'utf8')).toBe(await renderEmbedded());
  });
});
