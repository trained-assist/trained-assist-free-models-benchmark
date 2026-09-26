// fix-and-rerun.mjs — runs INSIDE the bench workflow, after the baseline.
//
// 1. installs deps for the opencode client (it shells out via npx)
// 2. for attempt 1..ATTEMPTS: `opencode run --auto -m MODEL "<fix the failing tests>"`
//    then re-runs the bucket script to count remaining failures
// 3. writes result.json (progress per attempt + final diff for expert review)
//
// This mirrors trained-assist-agent/src/issue-fixer.js: engine -> verify, up to N attempts.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const MODEL = process.env.MODEL;
const ATTEMPTS = parseInt(process.env.ATTEMPTS || '3', 10);
const repo = process.cwd();
const ws = process.env.GITHUB_WORKSPACE || process.cwd();

const run = (cmd, opts = {}) => {
  try { return { ok: true, out: execSync(cmd, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30 * 60_000, maxBuffer: 1 << 26, ...opts }) }; }
  catch (e) { return { ok: false, out: ((e.stdout || '') + (e.stderr || '')).toString() }; }
};

// install the opencode CLI
run('npm i -g opencode-ai@latest || true');
// target deps are needed for BOTH running tests and the model exploring the tree
run('npm ci');

const baseline = existsSync(`${ws}/baseline.json`) ? JSON.parse(readFileSync(`${ws}/baseline.json`, 'utf8')) : null;
const failing = [
  ...(baseline?.vitest?.failed || []),
  ...(baseline?.cjs?.failed || []),
].slice(0, 40).join('\n');

const prompt = [
  'The test suite in this repository is failing. Fix the CODE so the failing tests pass.',
  'Do NOT modify, delete or skip test files. Do not add `|| true`, eslint-disable or ts-ignore.',
  'Failing tests:', failing || '(see the test suite)',
].join('\n');

const attempts = [];
for (let i = 1; i <= ATTEMPTS; i++) {
  execSync(`opencode run --auto -m ${MODEL} ${JSON.stringify(prompt)}`, {
    cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], timeout: 45 * 60_000, maxBuffer: 1 << 26,
  });
  const r = run(`node "${ws}/scripts/ci-buckets.mjs" --phase attempt-${i} --out "${ws}/attempt-${i}.json"`);
  const res = existsSync(`${ws}/attempt-${i}.json`) ? JSON.parse(readFileSync(`${ws}/attempt-${i}.json`, 'utf8')) : { totalFailed: -1 };
  attempts.push({ attempt: i, totalFailed: res.totalFailed, vitestFailed: res.vitest?.failedCount, cjsFailed: res.cjs?.failedCount });
  if (res.totalFailed === 0) break;
}

// final diff for expert review + anti-cheat
const diff = run('git diff').out;
const changed = (diff.match(/^diff --git a\/.+$/gm) || []).map(l => l.replace(/^diff --git a\//, '').split(' b/')[0]);
const testFilesTouched = changed.filter(f => /(^|\/)(test|tests)\//.test(f) || /\.test\.(js|cjs)$/.test(f));
const bypass = /\|\|\s*true|\.skip\(|\.only\(|eslint-disable|@ts-ignore|@ts-nocheck/.test(diff);

writeFileSync(`${ws}/result.json`, JSON.stringify({
  model: MODEL, generated_at: new Date().toISOString(),
  baseline, attempts,
  solved: attempts.some(a => a.totalFailed === 0),
  final: { diffNonEmpty: diff.trim().length > 0, filesChanged: changed.length, testFilesTouched, bypass },
  cheatFree: diff.trim().length > 0 && testFilesTouched.length === 0 && !bypass,
}, null, 2));
writeFileSync(`${ws}/final.diff`, diff);
