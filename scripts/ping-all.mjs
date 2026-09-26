// ping-all.mjs — one-shot availability ping for every free model via `opencode run`.
// Writes results incrementally to ping-results.json so a slow/interrupted run keeps data.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { homedir } from 'os';

const ROOT = new URL('..', import.meta.url).pathname;
const OPENCODE = process.env.OPENCODE_BIN || `${homedir()}/.opencode/bin/opencode`;
const OUT = ROOT + 'results/ping-results.json';

const models = JSON.parse(readFileSync(ROOT + 'data/opencode-free-models.json', 'utf8')).models;
const only = process.argv[2] ? process.argv[2].split(',') : null;
const list = only ? models.filter(m => only.includes(m.id) || only.includes(`${m.provider}/${m.id}`)) : models;

const results = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { generated_at: new Date().toISOString(), pings: {} };
const pings = results.pings;

for (const m of list) {
  const ref = `${m.provider}/${m.id}`;
  const t0 = Date.now();
  let st = 'DEAD', text = '';
  try {
    const out = execFileSync(OPENCODE, ['run', '-m', ref, 'Reply with the single word: OK'], {
      encoding: 'utf8', timeout: 90000, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    text = out;
    st = /"ref":\s*"err_/.test(out) ? 'DEAD' : /(^|\n)\s*OK\s*$/.test(out.replace(/\r/g, '')) ? 'OK' : 'PARTIAL';
  } catch (e) {
    st = 'ERROR';
    text = ((e.stdout || '') + (e.stderr || '')).toString();
  }
  pings[ref] = { status: st, latency_ms: Date.now() - t0, error_snip: st === 'OK' ? null : text.slice(-200) };
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.error(`${st.padEnd(8)} ${ref} (${Math.round((Date.now() - t0) / 1000)}s)`);
}

const alive = Object.values(pings).filter(p => p.status === 'OK').length;
console.error(`\nOK: ${alive}/${Object.keys(pings).length}`);
