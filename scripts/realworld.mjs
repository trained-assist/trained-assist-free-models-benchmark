// realworld.mjs — SKELETON for the real-world auto-fix benchmark (issue #1).
//
// The real test: take a repo whose PR/CI is failing with a FIXABLE code cause, let a free
// model try to fix it (via `opencode run -m <provider>/<model>`), then check whether CI
// goes green. This is the job src/issue-fixer.js does in production — auto-fix is the
// primary consumer of whatever model this benchmark selects.
//
// STATUS: scaffold. The three hard parts are marked TODO and explained in README.md:
//   1. build a CORPUS of failing PRs where the failure is code-caused (not flaky/infra)
//   2. run the model through the real opencode client in an isolated clone
//   3. score with the anti-cheat rules (CI green AND tests unchanged AND diff non-empty)
//
// Usage: node scripts/realworld.mjs --corpus data/corpus.json --model opencode/big-pickle
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'fs';
import { execFileSync, execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { homedir } from 'os';

const OPENCODE = process.env.OPENCODE_BIN || `${homedir()}/.opencode/bin/opencode`;
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const corpusPath = opt('corpus', 'data/corpus.json');
const model = opt('model', null);
const outPath = opt('out', 'results/realworld.json');
if (!model) { console.error('need --model <provider>/<model>'); process.exit(2); }

// corpus.json shape (see README): [{ id, repo, baseSha, branch, failing, verifyCmd, cloneUrl }]
const corpus = existsSync(corpusPath) ? JSON.parse(readFileSync(corpusPath, 'utf8')) : [];
if (!corpus.length) { console.error(`no corpus at ${corpusPath} — see README "Corpus" section`); process.exit(2); }

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

// ── Anti-cheat scoring: "green CI" alone is not a win ────────────────────────────────
function score({ ciGreen, diff, testFilesChanged, taskPath }) {
  const diffNonEmpty = diff.trim().length > 0;
  const noTestEdits = testFilesChanged.length === 0;
  const noObviousBypass = !/\|\|\s*true|\.skip\(|@pytest\.mark\.skip|xit\(|\.only\(/.test(diff)
    || true; // TODO: decide when a skip is legitimate (subject rules live in issue #1)
  const pass = ciGreen && diffNonEmpty && noTestEdits && noObviousBypass;
  return { pass, ciGreen, diffNonEmpty, testFilesChanged, noObviousBypass };
}

const results = [];
for (const item of corpus) {
  const dir = mkdtempSync(join(tmpdir(), `bench-${item.id}-`));
  try {
    // 1. isolated clone at the failing state
    sh(`git clone --depth 1 ${item.cloneUrl || `https://github.com/${item.repo}.git`} "${dir}"`);
    sh(`git -C "${dir}" checkout ${item.baseSha || item.branch || 'HEAD'}`, { stdio: 'pipe' });

    // 2. let the model work in that clone (same client as production)
    const workDir = item.taskPath ? join(dir, item.taskPath) : dir;
    const prompt = `You are fixing a failing pull request in this repository. The task: make the failing CI pass by fixing the CODE (do not modify test files, do not delete or skip tests). Work only inside this directory.`;
    execFileSync(OPENCODE, ['run', '-m', model, prompt], { cwd: workDir, encoding: 'utf8', timeout: 15 * 60_000, stdio: ['ignore', 'pipe', 'pipe'] });

    // 3. verify + score
    const diff = sh(`git -C "${dir}" diff`);
    const testFilesChanged = diff.split('\n').filter(l => /^diff --git/.test(l) && /test|spec/i.test(l));
    let ciGreen = false;
    try { sh(item.verifyCmd || 'true', { cwd: workDir, timeout: 15 * 60_000 }); ciGreen = true; } catch { ciGreen = false; }
    // TODO: optionally open a fork+PR and let real GitHub CI decide (issue #1 asks for this on a subsample)

    results.push({ id: item.id, model, ...score({ ciGreen, diff, testFilesChanged, taskPath: workDir }) });
  } catch (e) {
    results.push({ id: item.id, model, pass: false, error: (e.stderr || e.message || '').toString().slice(0, 300) });
  } finally {
    rmSync(dir, { recursive: true, force: true }); // 4. clean workspace
    // TODO: delete the fork if one was created
  }
  console.error(`[realworld] ${item.id} -> ${results.at(-1).pass ? 'PASS' : 'fail'}`);
}

writeFileSync(outPath, JSON.stringify({ model, generated_at: new Date().toISOString(), results }, null, 2));
const passed = results.filter(r => r.pass).length;
console.error(`\n${model}: ${passed}/${results.length} fixed -> green`);
