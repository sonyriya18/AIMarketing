// Read-only preservation check for the protected Responsys application in ../responsys.
// It never writes inside the protected folder. Usage:
//   node preservation/verify-responsys.mjs          verify against preservation/RESPONSYS_BASELINE.json
//   node preservation/verify-responsys.mjs --archive       also report differences from the original
//                                                   23 Oct 2026 v17 archive baseline (informational)
//   node preservation/verify-responsys.mjs --create        create the baseline ONLY if none exists
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const tools = dirname(fileURLToPath(import.meta.url));
const root = resolve(tools, "..");
const app = resolve(root, process.env.RESPONSYS_PROTECTED_DIR || "responsys");
const baselinePath = resolve(tools, "RESPONSYS_BASELINE.json");
// Generated output, installed dependencies and local secret/runtime files are not hashed.
// Excluding them from hashing is NOT permission to change them.
const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist", "dist-server", "build", "coverage", "test-results", "playwright-report", "var", ".netlify", ".data", "runtime", ".local"]);
const EXCLUDED_FILES = [/^\.env(\..+)?$/, /^responsys_credentials\.env$/, /^config\/responsys-credentials\.json$/];
const allowedEnv = new Set([".env.example", "responsys_credentials.env.example"]);
const excluded = (rel) => {
  if (allowedEnv.has(rel)) return false;
  return EXCLUDED_FILES.some((r) => r.test(rel));
};
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (!EXCLUDED_DIRS.has(name)) walk(full, out);
    } else {
      const rel = relative(app, full).split(sep).join("/");
      if (!excluded(rel)) out.push(rel);
    }
  }
  return out;
}
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
if (!existsSync(app)) {
  console.error("FAIL: protected folder not found: " + app);
  process.exit(1);
}
const current = walk(app).sort();
if (process.argv.includes("--create")) {
  if (existsSync(baselinePath)) {
    console.error("Refusing to overwrite the existing baseline. Investigate differences instead of regenerating it.");
    process.exit(1);
  }
  const files = current.map((path) => ({ path, bytes: statSync(resolve(app, path)).size, sha256: sha(resolve(app, path)) }));
  writeFileSync(baselinePath, JSON.stringify({ created: new Date().toISOString(), protectedDir: "AIMarketing", lineage: process.env.RESPONSYS_LINEAGE || "Supplied Responsys release", excludedDirs: [...EXCLUDED_DIRS], excludedFiles: EXCLUDED_FILES.map(String), file_count: files.length, files }, null, 1) + "\n");
  console.log(`Created baseline with ${files.length} files.`);
  process.exit(0);
}
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const known = new Map(baseline.files.map((f) => [f.path, f.sha256]));
const failures = [];
for (const [path, hash] of known) {
  const full = resolve(app, path);
  if (!existsSync(full)) failures.push("Missing: " + path);
  else if (sha(full) !== hash) failures.push("Changed: " + path);
}
for (const path of current) if (!known.has(path)) failures.push("Added: " + path);
if (failures.length) {
  console.error(failures.join("\n"));
  console.error(`FAIL: ${failures.length} protected-file difference(s). Do not regenerate the baseline to hide them.`);
  process.exitCode = 1;
} else console.log(`PASS: All ${known.size} protected Responsys files match the baseline; no files added or removed.`);

if (process.argv.includes("--archive")) {
  const archive = JSON.parse(readFileSync(resolve(tools, "RESPONSYS_V17_ARCHIVE_BASELINE.json"), "utf8"));
  const diff = { changed: [], missing: [], addedSinceArchive: [] };
  const arch = new Map(archive.files.map((f) => [f.path, f.sha256]));
  for (const [path, hash] of arch) {
    const full = resolve(app, path);
    if (!existsSync(full)) diff.missing.push(path);
    else if (sha(full) !== hash) diff.changed.push(path);
  }
  for (const path of current) if (!arch.has(path)) diff.addedSinceArchive.push(path);
  console.log(`\nINFO: compared with the original archive ${archive.source_archive} (${archive.file_count} files):`);
  console.log(`  changed since archive: ${diff.changed.length}, removed: ${diff.missing.length}, added: ${diff.addedSinceArchive.length}`);
  for (const k of ["changed", "missing", "addedSinceArchive"]) for (const p of diff[k]) console.log(`  ${k}: ${p}`);
  console.log("  These are the user-approved later commits on v17 (see preservation/PRESERVATION.md), not changes made by the new platform.");
}
