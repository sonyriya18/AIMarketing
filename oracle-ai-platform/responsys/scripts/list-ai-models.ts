/**
 * Lists the Gemini models this API key can use for text generation (`npm run ai:models`), so
 * AI_MODEL and AI_FALLBACK_MODEL can be chosen from what Google offers today instead of guessed.
 * Reads the key from .env.local; prints model names only.
 */
import { existsSync, readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { listOpenAiModels } from './prompt';

async function main() {
  const env = existsSync('.env.local') ? dotenv.parse(readFileSync('.env.local')) : {};
  if (process.argv.includes('--nvidia')) {
    const nkey = process.env.NVIDIA_API_KEY || env.NVIDIA_API_KEY;
    if (!nkey) {
      console.error('No NVIDIA key found. Run npm run ai:nvidia first.');
      process.exit(1);
    }
    const ids = await listOpenAiModels(env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1', nkey);
    console.log(`NVIDIA models your key can use (${ids.length}):\n`);
    for (const id of ids) console.log(`  ${id}`);
    console.log(`\nIn use: NVIDIA_MODEL=${env.NVIDIA_MODEL || '(not set)'}  (change with npm run ai:nvidia)`);
    return;
  }
  const key = process.env.GEMINI_API_KEY || env.GEMINI_API_KEY;
  if (!key) {
    console.error('No Gemini key found. Run npm run ai:key first.');
    process.exit(1);
  }
  const ai = new GoogleGenAI({ apiKey: key });
  const rows: { name: string; label: string }[] = [];
  for await (const m of await ai.models.list({ config: { queryBase: true, pageSize: 100 } })) {
    const actions = m.supportedActions ?? [];
    if (!actions.includes('generateContent')) continue;
    rows.push({ name: (m.name ?? '').replace(/^models\//, ''), label: m.displayName ?? '' });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  console.log(`Models your key can use for text (${rows.length}):\n`);
  for (const r of rows) console.log(`  ${r.name.padEnd(40)} ${r.label}`);
  console.log(`\nIn use: AI_MODEL=${env.AI_MODEL || '(not set)'}  AI_FALLBACK_MODEL=${env.AI_FALLBACK_MODEL || '(not set)'}`);
  console.log('Change them with: npm run ai:key');
}

main().catch((e) => {
  console.error(`Could not list models: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
