/**
 * Terminal prompts for the local setup scripts. Secret answers are not echoed when the terminal
 * supports it (Windows Terminal, PowerShell, macOS/Linux shells).
 */
import readline from 'node:readline';

/** Model Google named on 2026-10-16 when it retired gemini-2.5-flash for new users. */
export const DEFAULT_AI_MODEL = 'gemini-3.8-flash';

export function ask(question: string, opts: { secret?: boolean } = {}): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
    if (opts.secret && process.stdin.isTTY) {
      const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
      let shown = false;
      out._writeToOutput = (s: string) => {
        if (!shown) {
          shown = true;
          process.stdout.write(s);
        } else if (s.includes('\n') || s.includes('\r')) process.stdout.write('\n');
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Sets NAME=value in a .env file's text, replacing an existing line or appending one. */
export function setEnvVar(content: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  const re = new RegExp(`^${name}=.*$`, 'm');
  return re.test(content) ? content.replace(re, () => line) : `${content.replace(/\n?$/, '\n')}${line}\n`;
}

export const envValue = (content: string, name: string): string => new RegExp(`^${name}=(.*)$`, 'm').exec(content)?.[1]?.trim() ?? '';

/** Model ids from an OpenAI-compatible /models endpoint (NVIDIA API catalog). */
export async function listOpenAiModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  const body = JSON.parse(text) as { data?: { id?: string }[] };
  return (body.data ?? []).map((m) => m.id ?? '').filter(Boolean).sort();
}
