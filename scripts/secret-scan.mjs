// secret-scan.mjs — fail if any tracked file (or the staged set) looks like it carries
// a credential. Runs in CI on every push, and as a pre-commit hook, so a raw log dump
// never reaches a public repo again (this is exactly how the oc_sk_ leak happened).
import { execFileSync } from 'child_process';

const PATTERNS = [
  ['openrouter/opencode key', /\b(?:oc_sk_|sk-)[A-Za-z0-9_-]{12,}/],
  ['neon token', /napi_[A-Za-z0-9]{16,}/],
  ['github token', /gh[pousr]_[A-Za-z0-9]{20,}/],
  ['aws key', /AKIA[0-9A-Z]{16}/],
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['telegram bot token', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
  ['google api key', /AIza[0-9A-Za-z_-]{30,}/],
];

const staged = process.argv.includes('--staged');
const rev = staged ? ':0' : 'HEAD';
let files = [];
try {
  files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
} catch { process.exit(0); }

let bad = 0;
for (const f of files) {
  let content;
  try { content = execFileSync('git', ['show', `${rev}:${f}`], { encoding: 'utf8', maxBuffer: 1 << 26 }); }
  catch { continue; } // not in the index (deleted/unstaged)
  for (const [name, re] of PATTERNS) {
    const m = content.match(re);
    if (m) { bad++; console.error(`secret-scan: ${f} looks like it contains a ${name} (…${m[0].slice(-6)})`); }
  }
}
if (bad) { console.error(`secret-scan: ${bad} hit(s) — refusing. Remove the secret and use secrets/env.`); process.exit(1); }
console.log('secret-scan: clean');
