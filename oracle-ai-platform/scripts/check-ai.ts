// Checks that this PC can use the configured AI (npm run ai:check, or 3-CHECK-AI.cmd on Windows).
// Sends one tiny request with the same code and network settings the platform uses. Prints the
// provider, model and result; never prints the key.
import { config } from "../server/config";
import { callModel, networkReason } from "../server/ai";

const cfg = config();
if (cfg.aiProvider === "none") {
  console.log(
    "AI is OFF (the reason is shown above, if any). Set AI_API_KEY and AI_MODEL in .env, or run 1-SETUP.cmd again, then try again.",
  );
  process.exit(1);
}
const via = process.env.HTTPS_PROXY
  ? ` through proxy ${process.env.HTTPS_PROXY}`
  : "";
console.log(
  `Checking ${cfg.aiProvider === "gemini" ? "Gemini" : "ChatGPT"} model "${cfg.aiModel}" at ${cfg.aiBase || "Google"}${via}...`,
);
try {
  const out = await callModel(
    cfg,
    'Health check. Return the JSON object {"ok":true}.',
    { check: "ping" },
    200,
  );
  console.log(
    `OK: the AI answered (${out.usage.total || "?"} tokens). AI insights and Ask AI will use it.`,
  );
} catch (e) {
  const msg = (e as Error).message || "";
  const plain =
    /could not be reached|did not answer|company|blocked|find/i.test(msg)
      ? msg
      : msg || networkReason(e, cfg).message;
  console.log("NOT WORKING: " + plain);
  process.exit(1);
}
