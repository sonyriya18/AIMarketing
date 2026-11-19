/**
 * Adds an NVIDIA API catalog key and model to .env.local (`npm run ai:nvidia`), either as the
 * backup used when Gemini is busy or as the main AI. The key is typed without being shown and is
 * written only to .env.local (ignored by git).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ask, envValue, listOpenAiModels, setEnvVar } from './prompt';

const ENV_FILE = '.env.local';
const DEFAULT_BASE = 'https://integrate.api.nvidia.com/v1';

async function main() {
  if (!existsSync(ENV_FILE)) {
    console.error('.env.local not found. Run npm run setup:local first.');
    process.exit(1);
  }
  let content = readFileSync(ENV_FILE, 'utf8');
  const base = envValue(content, 'NVIDIA_BASE_URL') || DEFAULT_BASE;
  const existing = envValue(content, 'NVIDIA_API_KEY');
  const typed = await ask(existing ? 'Paste a new NVIDIA API key, or press Enter to keep the current one (not shown): ' : 'Paste your NVIDIA API key (starts with nvapi-; not shown): ', { secret: true });
  const key = typed || existing;
  if (!key) {
    console.log('No key entered; nothing changed.');
    return;
  }
  let models: string[] = [];
  try {
    models = await listOpenAiModels(base, key);
    const chat = models.filter((m) => /instruct|chat|-it\b|nemotron|llama|mistral|qwen|gemma|deepseek|gpt-oss/i.test(m) && !/embed|rerank|vision|guard|reward|safety|parse|ocr|clip|tts|asr/i.test(m));
    console.log(`\nYour key works. Text models it can use (${chat.length} of ${models.length}):\n`);
    for (const m of chat) console.log(`  ${m}`);
    console.log('');
  } catch (e) {
    console.log(`\nCould not list NVIDIA models (${(e as Error).message}). You can still type a model id.\n`);
  }
  const currentModel = envValue(content, 'NVIDIA_MODEL');
  const model = (await ask(`Model id to use${currentModel ? ` [${currentModel}]` : ''} (for example an "instruct" model from the list): `)) || currentModel;
  if (!model) {
    console.log('No model chosen; nothing changed.');
    return;
  }
  if (models.length && !models.includes(model)) console.log(`Note: "${model}" was not in the list your key returned.`);
  const provider = envValue(content, 'AI_PROVIDER');
  const hasGemini = Boolean(envValue(content, 'GEMINI_API_KEY'));
  let role = '1';
  if (hasGemini) role = (await ask('Use NVIDIA as: 1 = backup when Gemini is busy (recommended), 2 = the main AI  [1]: ')) || '1';
  content = setEnvVar(content, 'NVIDIA_API_KEY', key);
  content = setEnvVar(content, 'NVIDIA_MODEL', model);
  if (!hasGemini || role === '2' || provider === 'none' || !provider) content = setEnvVar(content, 'AI_PROVIDER', 'nvidia');
  writeFileSync(ENV_FILE, content, { mode: 0o600 });
  const now = envValue(content, 'AI_PROVIDER');
  console.log(now === 'nvidia' ? `Saved. NVIDIA (${model}) is now the main AI.` : `Saved. Gemini stays the main AI; NVIDIA (${model}) takes over when Gemini is busy.`);
  console.log('Restart the app to apply: Ctrl+C, then npm run dev');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
