// find-cases.mjs — build the auto-fix benchmark corpus from our own history.
// Owner-set quota (depth scale): 2 cases with >=3 failing tests, 3 with exactly 2,
// 5 with exactly 1. Approach per case (owner-approved): take a fix commit, in an
// ISOLATED worktree stage `git revert` of it -> deterministically red, count failures,
// bucket it, clean up. Never touches main.
//
// Output: data/cases.json  (consumed by scripts/autofix-bench.mjs)
// Usage:  node scripts/find-cases.mjs --repo <path> [--candidates 200]
import { execFileSync, execSync } from 'child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const REPO = opt('repo', process.env.HOME + '/Code/trained-assist-agent');
const CANDIDATES = parseInt(opt('candidates', '200'), 10);

const git = (a, cwd = REPO) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function candidateCommits() {
  const log = git(['log', '--format=%H|%s', `-${CANDIDATES}`]);
  const out = [];
  for (const line of log.split('\n')) {
    const [sha, ...rest] = line.split('|');
    const subject = rest.join('|');
    if (!/^(fix|feat)(\(|:)/i.test(subject)) continue;
    if (/^fix:\s*auto-fix CI failure/i.test(subject)) continue;
    let files = [];
    try { files = git(['show', '--name-only', '--format=', sha]).split('\n').filter(Boolean); } catch { continue; }
    const touchedTests = files.filter(f => /(^|\/)(test|tests)\//.test(f) || /\.test\.(js|cjs)$/.test(f));
    const touchedSrc = files.filter(f => /^src\//.test(f));
    if (!touchedTests.length || !touchedSrc.length) continue;
    out.push({ sha, subject, touchedTests, touchedSrc });
  }
  return out;
}

function runTouchedTests(cwd, touchedTests) {
  const vitestFiles = touchedTests.filter(f => /^tests\//.test(f) && existsSync(join(cwd, f)));
  const cjsFiles = touchedTests.filter(f => /^test\//.test(f) && existsSync(join(cwd, f)));
  let failed = 0, passed = 0, failedNames = [];
  const run = (cmd) => { try { execSync(cmd, { cwd, stdio: 'pipe', timeout: 8 * 60_000, maxBuffer: 1 << 26 }); return ''; } catch (e) { return ((e.stdout || '') + (e.stderr || '')).toString(); } };

  if (vitestFiles.length) {
    const jf = `/tmp/vitest-${process.pid}.json`;
    run(`npx vitest run ${vitestFiles.map(f => `"${f}"`).join(' ')} --reporter=json --outputFile=${jf}`);
    try {
      const j = JSON.parse(readFileSync(jf, 'utf8'));
      for (const tr of j.testResults || []) for (const a of tr.assertionResults || []) {
        if (a.status === 'failed') { failed++; failedNames.push(a.fullName || a.title); } else if (a.status === 'passed') passed++;
      }
      rmSync(jf, { force: true });
    } catch {}
  }
  for (const f of cjsFiles) {
    const out = run(`node --test "${f}"`);
    const mf = (out.match(/^# fail (\d+)/m) || [])[1];
    if (mf) failed += parseInt(mf, 10); else if (/# fail [1-9]/.test(out)) failed += 1;
  }
  return { failed, passed, failedNames, vitestFiles, cjsFiles };
}

const candidates = candidateCommits();
console.error(`candidate fix/feat commits touching tests: ${candidates.length}`);

const quota = { '3+': 2, '2': 3, '1': 5 };
const cases = [];
const bucketOf = n => n >= 3 ? '3+' : n === 2 ? '2' : n === 1 ? '1' : null;

for (const c of candidates) {
  if (Object.entries(quota).every(([k, v]) => (cases.filter(x => x.bucket === k).length) >= v)) break;
  const wt = mkdtempSync(join(tmpdir(), 'case-'));
  try {
    git(['worktree', 'add', '--detach', wt, `${c.sha}~1`], REPO);
    const stat = runTouchedTests(wt, c.touchedTests);
    const bucket = bucketOf(stat.failed);
    if (bucket && cases.filter(x => x.bucket === bucket).length < quota[bucket]) {
      cases.push({
        id: c.sha.slice(0, 8), repo: REPO, baseCommit: `${c.sha}~1`, fixCommit: c.sha,
        subject: c.subject, bucket, failedCount: stat.failed,
        vitestFiles: stat.vitestFiles, cjsFiles: stat.cjsFiles,
        failedTests: stat.failedNames.slice(0, 30),
      });
      console.error(`KEEP [${bucket}] ${c.sha.slice(0, 8)} failed=${stat.failed}  ${c.subject.slice(0, 55)}`);
    }
  } catch (e) {
    console.error(`err ${c.sha.slice(0, 8)}: ${e.message.slice(0, 70)}`);
  } finally {
    try { git(['worktree', 'remove', '--force', wt], REPO); } catch {}
    try { rmSync(wt, { recursive: true, force: true }); } catch {}
  }
}

writeFileSync(new URL('../data/cases.json', import.meta.url), JSON.stringify(cases, null, 2));
const counts = { '3+': cases.filter(c => c.bucket === '3+').length, '2': cases.filter(c => c.bucket === '2').length, '1': cases.filter(c => c.bucket === '1').length };
console.error(`\nCASES: ${cases.length}  (want 2/3/5)  got ${JSON.stringify(counts)}`);
