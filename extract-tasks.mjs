// Extract task-like user prompts from Claude session logs for benchmarking.
import { readdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';

const ROOTS = [
  process.env.HOME + '/.claude/projects',
];
const out = [];
let files = 0;
function walk(dir) {
  let ents = [];
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl')) {
      files++;
      let lines = [];
      try { lines = readFileSync(p, 'utf8').split('\n'); } catch { continue; }
      for (const l of lines) {
        if (!l.trim()) continue;
        let j; try { j = JSON.parse(l); } catch { continue; }
        // user turns only, non-tool, non-meta
        const msg = j.message || j;
        if (msg?.role !== 'user') continue;
        let text = msg.content;
        if (Array.isArray(text)) text = text.map(c => c?.text || '').join('\n');
        if (typeof text !== 'string') continue;
        if (text.includes('<command-name>') || text.startsWith('[Request interrupted')) continue;
        text = text.trim();
        if (text.length < 25 || text.length > 1200) continue;
        // keep task-like prompts (verbs / requests), skip pure chatter
        out.push({ src: p.split('/projects/')[1].split('/')[0], text });
      }
    }
  }
}
for (const r of ROOTS) walk(r);
// dedupe
const seen = new Set();
const uniq = out.filter(o => { const k = o.text.slice(0,160); if (seen.has(k)) return false; seen.add(k); return true; });
writeFileSync('research/tasks-raw.json', JSON.stringify({ files, count: uniq.length, tasks: uniq }, null, 2));
console.log('files', files, 'raw', out.length, 'uniq', uniq.length);
