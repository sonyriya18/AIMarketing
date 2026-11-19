/**
 * Times one small real request to the main and the backup Gemini model (`npm run ai:test`), so a
 * slow, busy or refused model can be told apart from an app problem. `npm run ai:test -- --all`
 * tries every Gemini text model the key can use, to find one that answers right now.
 * Reads the key from .env.local; prints model names, timings and Google's message only (never the key).
 */
import { existsSync, readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { describeAiError, tuningFor } from '../server/integrations/ai/provider';

const all = process.argv.includes('--all');
const LIMIT_MS = all ? 25_000 : 60_000;
// Models that do not write plain text answers (images, speech, embeddings, live audio).
const NOT_TEXT = /image|tts|embedding|live|audio|native|veo|imagen|aqa|learnlm|robotics|computer-use/i;

async function tryModel(ai: GoogleGenAI, model: string): Promise<{ ok: boolean; line: string }> {
  const started = Date.now();
  const secs = () => ((Date.now() - started) / 1000).toFixed(1);
  try {
    const res = await ai.models.generateContent({
      model,
      contents: 'Write a friendly 80-word paragraph for a marketing email announcing a new clothing collection.',
      config: {
        responseMimeType: 'application/json',
        responseJsonSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        maxOutputTokens: 2048,
        ...tuningFor(model),
        abortSignal: AbortSignal.timeout(LIMIT_MS),
      },
    });
    const ok = Boolean(res.text?.trim());
    return { ok, line: ok ? `OK in ${secs()} s` : `answered in ${secs()} s but the answer was empty` };
  } catch (e) {
    return { ok: false, line: `FAILED after ${secs()} s\n        ${describeAiError(e, model, LIMIT_MS).message}` };
  }
}

async function main() {
  const env = existsSync('.env.local') ? dotenv.parse(readFileSync('.env.local')) : {};
  const key = process.env.GEMINI_API_KEY || env.GEMINI_API_KEY;
  if (!key) {
    console.error('No Gemini key found. Run npm run ai:key first.');
    process.exit(1);
  }
  const ai = new GoogleGenAI({ apiKey: key });

  if (all) {
    const names: string[] = [];
    for await (const m of await ai.models.list({ config: { queryBase: true, pageSize: 100 } })) {
      const name = (m.name ?? '').replace(/^models\//, '');
      if ((m.supportedActions ?? []).includes('generateContent') && name.startsWith('gemini') && !NOT_TEXT.test(name)) names.push(name);
    }
    names.sort();
    console.log(`Trying ${names.length} Gemini text models, one small request each (up to ${LIMIT_MS / 1000} s each)…\n`);
    const working: string[] = [];
    for (const name of names) {
      process.stdout.write(`  ${name.padEnd(40)} `);
      const r = await tryModel(ai, name);
      console.log(r.line.split('\n')[0] + (r.ok ? '' : ` — ${r.line.split('\n')[1]?.trim().slice(0, 90) ?? ''}`));
      if (r.ok) working.push(name);
    }
    console.log(working.length
      ? `\nWorking right now: ${working.join(', ')}\nUse one with: npm run ai:key  (Enter to keep the key, type a working model as the model, another as the backup)`
      : '\nNo model answered right now. Wait a few minutes and run this again.');
    return;
  }

  const models = [env.AI_MODEL || 'gemini-3.8-flash', env.AI_FALLBACK_MODEL].filter((m): m is string => Boolean(m));
  let anyOk = false;
  for (const [i, model] of models.entries()) {
    process.stdout.write(`${i === 0 ? 'Main  ' : 'Backup'} model ${model}: asking… `);
    const r = await tryModel(ai, model);
    anyOk ||= r.ok;
    console.log(r.line);
  }
  if (models.length < 2) console.log('\nNo backup model set. Add one with npm run ai:key (for example gemini-3.5-flash-lite).');
  console.log(anyOk ? '\nAt least one model works. Restart npm run dev if you changed settings.' : '\nNo model answered. Find one that works right now with: npm run ai:test -- --all');
}

main().catch((e) => {
  console.error(describeAiError(e, 'gemini', LIMIT_MS).message);
  process.exit(1);
});
