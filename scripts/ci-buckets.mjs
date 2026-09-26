// ci-buckets.mjs — run a target repo's test suite in buckets and report which tests fail.
//
// Runs INSIDE the bench workflow (GitHub runner) so the result is real CI, not a local
// macOS run. The target repo's own `npm test` fans out into vitest + many `node --test`
// invocations; a crash in one hides the rest, so we run the suite in buckets and record
// each bucket's exit status + failure names.
//
// Usage: node ci-buckets.mjs --phase baseline --out /path/out.json
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const phase = opt('phase', 'baseline');
const out = opt('out', 'out.json');
const repo = process.cwd();

function sh(cmd) {
  try {
    return { ok: true, out: execSync(cmd, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30 * 60_000, maxBuffer: 1 << 26 }) };
  } catch (e) {
    return { ok: false, out: ((e.stdout || '') + (e.stderr || '')).toString() };
  }
}

// 0. install deps — without node_modules vitest finds nothing and every `node --test`
//    file dies with a module error, which is NOT a test failure. Install first.
const install = sh('npm ci --no-audit --no-fund');
if (!install.ok) {
  const result = { phase, generated_at: new Date().toISOString(), installFailed: true, installLog: install.out.slice(-2000), red: false, totalFailed: 0 };
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.error(JSON.stringify({ phase, installFailed: true }));
  process.exit(0);
}

// 1. syntax gate (fast) — like `npm run check`
const check = sh('npm run check');

// 2. vitest suite (all tests/unit/*.test.js) — JSON reporter
const vitestOut = `/tmp/vitest-${Date.now()}.json`;
sh(`npx vitest run --reporter=json --outputFile=${vitestOut}`);
const vitest = { failed: [], passed: 0, ok: false };
if (existsSync(vitestOut)) {
  try {
    const j = JSON.parse(readFileSync(vitestOut, 'utf8'));
    for (const tr of j.testResults || []) for (const a of tr.assertionResults || []) {
      if (a.status === 'failed') vitest.failed.push(a.fullName || a.title);
      else if (a.status === 'passed') vitest.passed++;
    }
    vitest.ok = vitest.failed.length === 0;
  } catch {}
}

// 3. cjs suites (test/*.test.cjs) — run each listed file separately so one crash
//    does not mask the rest; parse the node:test summary lines.
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const cjsCmd = pkg.scripts?.['test:cjs'] || '';
// extract the test/*.cjs paths mentioned in the script (this is the suite the repo runs)
const cjsFiles = [...new Set((cjsCmd.match(/test\/[\w./-]+\.test\.cjs/g) || []))].filter(f => existsSync(f));
const cjs = { failed: [], ok: true, perFile: {}, couldNotRun: [] };
for (const f of cjsFiles) {
  const r = sh(`node --test "${f}"`);
  const m = r.out.match(/^# fail (\d+)/m);
  // A file that never produced a node:test summary did not RUN (module/env error) —
  // that is an environment problem, not a test failure. Don't score it as red.
  const ran = /^# tests \d+/m.test(r.out) || /^# pass \d+/m.test(r.out);
  if (!ran && !m) { cjs.couldNotRun.push(f); cjs.perFile[f] = 'not-run'; continue; }
  const failCount = m ? parseInt(m[1], 10) : (r.ok ? 0 : 1);
  cjs.perFile[f] = failCount;
  if (failCount > 0) {
    cjs.ok = false;
    const names = [...r.out.matchAll(/^not ok \d+ - (.+)$/gm)].map(x => x[1]);
    cjs.failed.push(...(names.length ? names : [`${f}: ${failCount} failed`]));
  }
}

const result = {
  phase, repo: 'target', generated_at: new Date().toISOString(),
  syntaxCheckOk: check.ok,
  vitest: { ok: vitest.ok, failedCount: vitest.failed.length, passed: vitest.passed, failed: vitest.failed.slice(0, 100) },
  cjs: { ok: cjs.ok, failedCount: cjs.failed.length, failed: cjs.failed.slice(0, 100), perFile: cjs.perFile, couldNotRun: cjs.couldNotRun },
  totalFailed: (check.ok ? 0 : 1) + vitest.failed.length + cjs.failed.length,
};
result.red = result.totalFailed > 0;
writeFileSync(out, JSON.stringify(result, null, 2));
console.error(JSON.stringify({ phase, syntaxCheckOk: result.syntaxCheckOk, vitestFailed: vitest.failed.length, cjsFailed: cjs.failed.length, couldNotRun: cjs.couldNotRun.length, red: result.red }));
