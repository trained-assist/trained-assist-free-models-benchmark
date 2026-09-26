// run-ci.mjs — trigger the bench-run workflow for a target ref and collect its artifacts.
//
// This is how we get a REAL CI result: dispatch the workflow (which checks out the target
// repo at `ref` and runs its suite in GitHub's runner), wait for it, download the
// baseline/result artifacts, and print the red/green summary.
//
// Usage:
//   node scripts/run-ci.mjs --ref <sha>                       # baseline only (is it red?)
//   node scripts/run-ci.mjs --ref <sha> --model opencode/space-bunny-free
import { execFileSync } from 'child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const REF_IN = opt('ref', null);
const MODEL = opt('model', '');
const REPO = opt('repo', 'trained-assist/trained-assist-free-models-benchmark');
const TARGET = opt('target', 'trained-assist/trained-assist-agent');
const ATTEMPTS = opt('attempts', '3');
if (!REF_IN) { console.error('need --ref <sha>'); process.exit(2); }

const gh = (a, o = {}) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 1 << 26, ...o });

// actions/checkout only accepts a FULL 40-char SHA for a detached checkout; a short
// SHA is interpreted as a branch name and the fetch fails. Resolve it first.
let REF = REF_IN;
if (/^[0-9a-f]{7,39}$/i.test(REF_IN)) {
  REF = gh(['api', `repos/${TARGET}/commits/${REF_IN}`, '--jq', '.sha']).trim();
  console.error(`resolved ${REF_IN} -> ${REF}`);
}

// 1. dispatch
gh(['workflow', 'run', 'bench-run.yml', '-R', REPO,
  '-f', `target_repo=${TARGET}`, '-f', `ref=${REF}`, '-f', `model=${MODEL}`, '-f', `attempts=${ATTEMPTS}`]);
console.error(`dispatched bench-run for ${TARGET}@${REF}${MODEL ? ` with ${MODEL}` : ''}`);

// 2. find the run
await new Promise(r => setTimeout(r, 8000));
let runId = null;
for (let i = 0; i < 10 && !runId; i++) {
  const list = JSON.parse(gh(['run', 'list', '-R', REPO, '--workflow', 'bench-run.yml', '--limit', '5', '--json', 'databaseId,status,createdAt']));
  runId = list[0]?.databaseId;
  if (!runId) await new Promise(r => setTimeout(r, 5000));
}
if (!runId) { console.error('could not find the dispatched run'); process.exit(1); }
console.error(`run ${runId} — watching...`);

// 3. wait (live logs to stderr)
try { execFileSync('gh', ['run', 'watch', String(runId), '-R', REPO, '--exit-status'], { stdio: ['ignore', 'inherit', 'inherit'] }); }
catch { console.error('run finished non-zero (expected for a RED baseline)'); }

// 4. download artifacts
const dir = mkdtempSync(join(tmpdir(), 'bench-art-'));
try { gh(['run', 'download', String(runId), '-R', REPO, '-D', dir]); } catch (e) { console.error('artifact download failed:', e.message.slice(0, 120)); }

// 5. summarize
function read(name) {
  for (const f of readdirSync(dir, { recursive: true })) {
    if (String(f).endsWith(name)) { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch {} }
  }
  return null;
}
const baseline = read('baseline.json');
const result = read('result.json');
console.error(JSON.stringify({ runId, ref: REF, model: MODEL || null, baseline, result }, null, 2));
