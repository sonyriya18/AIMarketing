/**
 * Adds or replaces the Gemini settings in .env.local (`npm run ai:key`). The key is typed
 * without being shown and is written only to .env.local, which git ignores.
 * Use `npm run ai:key -- --off` to switch AI off again.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ask, DEFAULT_AI_MODEL, setEnvVar as setVar } from './prompt';

const ENV_FILE = '.env.local';

async function main() {
  if (!existsSync(ENV_FILE)) {
    console.error('.env.local not found. Run npm run setup:local first.');
    process.exit(1);
  }
  let content = readFileSync(ENV_FILE, 'utf8');
  if (process.argv.includes('--off')) {
    content = setVar(content, 'AI_PROVIDER', 'none');
    writeFileSync(ENV_FILE, content, { mode: 0o600 });
    console.log('AI switched off. Restart npm run dev.');
    return;
  }
  const existing = /^GEMINI_API_KEY=(.+)$/m.exec(content)?.[1]?.trim();
  const typed = await ask(existing ? 'Paste a new Gemini API key, or press Enter to keep the current one (not shown): ' : 'Paste your Gemini API key (it is not shown): ', { secret: true });
  const key = typed || existing;
  if (!key) {
    console.log('No key entered; nothing changed.');
    return;
  }
  const model = (process.stdin.isTTY ? await ask(`Model name [${DEFAULT_AI_MODEL}] (press Enter to keep): `) : '') || DEFAULT_AI_MODEL;
  content = setVar(content, 'AI_PROVIDER', 'gemini');
  content = setVar(content, 'AI_MODEL', model);
  content = setVar(content, 'GEMINI_API_KEY', key);
  if (process.stdin.isTTY) {
    const current = /^AI_FALLBACK_MODEL=(.*)$/m.exec(content)?.[1]?.trim() ?? '';
    const fallback = await ask(`Backup model used only when ${model} is busy (see npm run ai:models; Enter = ${current || 'none'}, "-" = none): `);
    if (fallback === '-') content = setVar(content, 'AI_FALLBACK_MODEL', '');
    else if (fallback) content = setVar(content, 'AI_FALLBACK_MODEL', fallback);
  }
  writeFileSync(ENV_FILE, content, { mode: 0o600 });
  const fb = /^AI_FALLBACK_MODEL=(.*)$/m.exec(content)?.[1]?.trim();
  console.log(`Saved. AI uses ${model}${fb ? `, backup ${fb}` : ''}. Restart npm run dev (Ctrl+C, then npm run dev) to apply.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
