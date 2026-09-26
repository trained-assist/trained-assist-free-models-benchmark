// autofix-bench.mjs — the real benchmark: can a free model fix known-failing tests?
//
// This is a faithful copy of the production pipeline in
// trained-assist-agent/src/issue-fixer.js (clone -> engine -> verify, up to N attempts),
// with the issue replaced by a case that has KNOWN failing tests:
//   * base state = `git revert` of a real fix commit, staged in an isolated worktree
//     (never touches main) -> deterministically red
//   * the model gets ONLY the failing-test log + a pointed instruction, and works
//     agentically inside the worktree (opencode run --auto), exactly like production.
//
// Simple launch (owner request), deep analytics (owner request):
//   per case: for attempt 1..3 { model fixes -> run the case's tests } ; record the
//   number of green tests after EACH attempt (depth / progress), the residual failures
//   by kind, an anti-cheat check, and leave the final diff for expert review.
//
// Usage: node scripts/autofix-bench.mjs --model opencode/space-bunny-free [--cases 3] [--attempts 3]
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { execFileSync, execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const MODEL = opt('model', null);
const ATTEMPTS = parseInt(opt('attempts', '3'), 10);
const LIMIT = parseInt(opt('cases', '0'), 10) || Infinity;
const OPENCODE = process.env.OPENCODE_BIN || `${process.env.HOME}/.opencode/bin/opencode`;
const OUT = new URL('../results/', import.meta.url).pathname;
if (!MODEL) { console.error('need --model <provider>/<model>'); process.exit(2); }

const cases = JSON.parse(readFileSync(new URL('../data/cases.json', import.meta.url), 'utf8')).slice(0, LIMIT);
mkdirSync(OUT, { recursive: true });

// ── anti-cheat ──────────────────────────────────────────────────────────────────────
const BYPASS = /\|\|\s*true|\.skip\(|\.only\(|@pytest\.mark\.skip|xit\(|xdescribe\(|eslint-disable|@ts-ignore|@ts-nocheck/;
function diffStats(cwd, baseSha) {
  const diff = execSync(`git diff ${baseSha} -- .`, { cwd, encoding: 'utf8', maxBuffer: 1 << 26 });
  const changed = diff.split('\n').filter(l => /^diff --git/.test(l)).map(l => l.replace(/^diff --git a\//, '').split(' b/')[0]);
  const testFilesTouched = changed.filter(f => /(^|\/)(test|tests)\//.test(f) || /\.test\.(js|cjs)$/.test(f));
  return {
    nonEmpty: diff.trim().length > 0,
    filesChanged: changed.length,
    testFilesTouched,
    bypassPatterns: BYPASS.test(diff) ? (diff.match(BYPASS) || [])[0] : null,
  };
}

// ── test runner: count green vs failed for the case's own test files ─────────────────
function runCaseTests(cwd, c) {
  const vitest = (c.vitestFiles || []).filter(f => existsSync(join(cwd, f)));
  const cjs = (c.cjsFiles || []).filter(f => existsSync(join(cwd, f)));
  let passed = 0, failed = 0, failedNames = [], types = {};
  const run = (cmd) => { try { execSync(cmd, { cwd, stdio: 'pipe', timeout: 8 * 60_000, maxBuffer: 1 << 26 }); return { out: '', ok: true }; } catch (e) { return { out: ((e.stdout || '') + (e.stderr || '')).toString(), ok: false }; } };

  if (vitest.length) {
    const jsonFile = `/tmp/bench-vitest-${process.pid}.json`;
    run(`npx vitest run ${vitest.map(f => `"${f}"`).join(' ')} --reporter=json --outputFile=${jsonFile}`);
    try {
      const j = JSON.parse(readFileSync(jsonFile, 'utf8'));
      for (const tr of j.testResults || []) for (const a of tr.assertionResults || []) {
        if (a.status === 'failed') { failed++; failedNames.push(a.fullName || a.title); }
        else if (a.status === 'passed') passed++;
      }
      rmSync(jsonFile, { force: true });
    } catch {}
  }
  for (const f of cjs) {
    const r = run(`node --test "${f}"`);
    const mf = (r.out.match(/^# fail (\d+)/m) || [])[1];
    if (mf) failed += parseInt(mf, 10); else if (!r.ok) failed += 1;
  }
  // coarse residual-failure kinds from the log
  const log = failedNames.join('\n');
  if (/import|SyntaxError|Cannot find module/i.test(log)) types.structural = true;
  if (/timeout|exceeded/i.test(log)) types.timeout = true;
  if (/expected|toBe|toEqual|assert/i.test(log)) types.assertion = true;
  return { passed, failed, failedNames: failedNames.slice(0, 40), types };
}

const results = [];
for (const c of cases) {
  const wt = join(tmpdir(), `autofix-${c.id}-${Date.now()}`);
  const rec = { case: c.id, subject: c.subject, model: MODEL, baseCommit: c.baseCommit, attempts: [], solved: false, final: null, error: null };
  try {
    execSync(`git worktree add --detach "${wt}" ${c.baseCommit}`, { cwd: c.repo, stdio: 'pipe' });
    // baseline (should be the known-red state) + verify our corpus number
    const baseline = runCaseTests(wt, c);
    rec.baseline = { failed: baseline.failed, passed: baseline.passed, failedNames: baseline.failedNames.slice(0, 10) };
    rmSync(join(wt, 'node_modules'), { recursive: true, force: true });
    execSync('npm ci', { cwd: wt, stdio: 'pipe', timeout: 15 * 60_000, maxBuffer: 1 << 26 });

    const failing = baseline.failedNames.length ? baseline.failedNames.join('\n') : c.failedTests?.join('\n') || '(see test files)';
    const prompt = [
      'Failing tests were reverted into this repository. Fix the CODE so the failing tests pass.',
      'Do NOT modify, delete, or skip test files. Do not add `|| true`, eslint-disable or ts-ignore.',
      `Test files: ${[...(c.vitestFiles || []), ...(c.cjsFiles || [])].join(', ')}`,
      'Failing test names:', failing,
    ].join('\n');

    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      execFileSync(OPENCODE, ['run', '--auto', '-m', MODEL, prompt], {
        cwd: wt, encoding: 'utf8', timeout: 15 * 60_000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26,
      });
      const r = runCaseTests(wt, c);
      rec.attempts.push({ attempt, passed: r.passed, failed: r.failed, failedNames: r.failedNames.slice(0, 10), types: r.types });
      if (r.failed === 0 && r.passed > 0) { rec.solved = true; break; }
    }

    const d = diffStats(wt, c.baseCommit);
    rec.final = {
      diffNonEmpty: d.nonEmpty, filesChanged: d.filesChanged,
      testFilesTouched: d.testFilesTouched, bypass: d.bypassPatterns,
      cheatFree: d.nonEmpty && d.testFilesTouched.length === 0 && !d.bypassPatterns,
    };
    rec.pass = rec.solved && rec.final.cheatFree;
    // save the diff for expert review
    try {
      const diff = execSync(`git diff ${c.baseCommit} -- .`, { cwd: wt, encoding: 'utf8', maxBuffer: 1 << 26 });
      writeFileSync(join(OUT, `diff-${c.id}-${MODEL.replace(/\W/g, '_')}.patch`), diff);
    } catch {}
  } catch (e) {
    rec.error = (e.stderr || e.message || '').toString().slice(0, 300);
    rec.pass = false;
  } finally {
    try { execSync(`git worktree remove --force "${wt}"`, { cwd: c.repo, stdio: 'pipe' }); } catch {}
    try { rmSync(wt, { recursive: true, force: true }); } catch {}
  }
  results.push(rec);
  const depth = rec.attempts.map(a => `${a.passed}✓/${a.failed}✗`).join(' -> ') || 'n/a';
  console.error(`${rec.pass ? 'PASS' : 'fail'}  ${c.id}  ${depth}  cheatFree=${rec.final?.cheatFree}`);
}

writeFileSync(join(OUT, `autofix-${MODEL.replace(/\W/g, '_')}.json`), JSON.stringify({ model: MODEL, generated_at: new Date().toISOString(), results }, null, 2));
const passed = results.filter(r => r.pass).length;
console.error(`\n${MODEL}: ${passed}/${results.length} solved-and-cheat-free`);
