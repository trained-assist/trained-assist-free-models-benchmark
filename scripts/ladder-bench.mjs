#!/usr/bin/env node
// ladder-bench.mjs — continuous benchmark of OUR LLM API: the trained-assist-llm-ladder worker
// (https://llm-ladder.trainedassist.store). Owner 2026-09-27: «чтобы наши апи работали, нужно
// гонять бенчмарки постоянно и смотреть что да как».
//
// Two passes, both through the worker (provider keys stay in the worker):
//   1. per rung  — every rung of every ladder pinned via `ladder_rung` (no failover): does this
//                  model answer, how fast, does the answer have the right shape?
//   2. per ladder — the ladder as clients see it (failover on): which rung answered, latency.
// Tasks: ping + JSON mode + a tool call + the 3 realistic inputs in data/avg-inputs.json, each
// with a machine-checkable shape so "answered" != "garbage".
//
// Output: results/ladder-bench-latest.json (full), results/ladder-bench-history.jsonl (one
// summary line per run), markdown summary on stdout (CI puts it in the step summary).
//
// Usage: LLM_LADDER_TOKEN=... node scripts/ladder-bench.mjs [--ladders deepseek,free] [--quick]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL_BASE = (process.env.LLM_LADDER_URL || 'https://llm-ladder.trainedassist.store').replace(/\/+$/, '');
const TOKEN = process.env.LLM_LADDER_TOKEN;
if (!TOKEN) { console.error('LLM_LADDER_TOKEN not set'); process.exit(2); }
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const QUICK = process.argv.includes('--quick');
const ONLY = arg('--ladders') ? arg('--ladders').split(',') : null;

const avg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/avg-inputs.json'), 'utf8')).inputs;

// Shape checks — cheap, deterministic, same spirit as data/avg-inputs.json "expect".
const TASKS = [
  { id: 'ping', body: { messages: [{ role: 'user', content: 'Reply with the single word: OK' }], max_tokens: 20 },
    check: (m) => /\bok\b/i.test(m.content || '') },
  { id: 'json', body: { messages: [{ role: 'user', content: 'Return JSON {"sum": <2+3>} and nothing else.' }], response_format: { type: 'json_object' } },
    check: (m) => { try { return JSON.parse(String(m.content).replace(/^```(?:json)?|```$/g, '').trim()).sum === 5; } catch { return false; } } },
  { id: 'tool', body: {
      messages: [{ role: 'user', content: 'What is the weather in Moscow? Use the tool.' }],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'Weather by city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }] },
    check: (m) => (m.tool_calls || []).some(t => t.function?.name === 'get_weather') },
  ...(QUICK ? [] : avg.map(inp => ({
    id: inp.id, body: { messages: [{ role: 'user', content: inp.text }] },
    check: {
      'code-fix': (m) => /<\s*nums\.length|i\s*<\s*nums\.length/.test(m.content || '') && /function\s+sumEven/.test(m.content || ''),
      'code-gen': (m) => /function\s+chunk\s*\(/.test(m.content || '') && /RangeError/.test(m.content || ''),
      'agent-plan': (m) => (String(m.content || '').match(/^\s*\d+[.)]/gm) || []).length >= 3,
    }[inp.id] || ((m) => !!m.content),
  }))),
];

async function call(body, { rung = null, timeoutMs = 90_000 } = {}) {
  const started = Date.now();
  try {
    const res = await fetch(`${URL_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, ladder_timeout_ms: 45_000, ...(rung ? { ladder_rung: rung } : {}) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => null);
    const ms = Date.now() - started;
    if (!res.ok) return { ok: false, ms, status: res.status, error: String(data?.error?.attempts?.map(a => a.error).filter(Boolean).pop() || data?.error?.message || res.status).slice(0, 200) };
    return { ok: true, ms, model: data?.model, message: data?.choices?.[0]?.message || {}, usage: data?.usage || null };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: `fetch: ${e.message}`.slice(0, 200) };
  }
}

const models = await (await fetch(`${URL_BASE}/v1/models`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
const ladders = models.data.filter(m => !m.id.includes(':') && (!ONLY || ONLY.includes(m.id)));

const runAt = new Date().toISOString();
const out = { runAt, url: URL_BASE, quick: QUICK, rungs: [], ladders: [] };

for (const l of ladders) {
  for (const rung of l.rungs) {
    const row = { ladder: l.id, rung, tasks: {} };
    for (const t of TASKS) {
      const r = await call({ ...t.body, model: l.id }, { rung });
      row.tasks[t.id] = { answered: r.ok, pass: r.ok && t.check(r.message), ms: r.ms, ...(r.ok ? {} : { error: r.error }) };
      console.error(`[rung] ${l.id} ${rung} ${t.id}: ${row.tasks[t.id].pass ? 'PASS' : row.tasks[t.id].answered ? 'shape-fail' : 'ERR ' + r.error} ${r.ms}ms`);
    }
    out.rungs.push(row);
  }
  const lrow = { ladder: l.id, tasks: {} };
  for (const t of TASKS) {
    const r = await call({ ...t.body, model: l.id });
    lrow.tasks[t.id] = { answered: r.ok, pass: r.ok && t.check(r.message), ms: r.ms, model: r.model || null, ...(r.ok ? {} : { error: r.error }) };
    console.error(`[ladder] ${l.id} ${t.id}: ${lrow.tasks[t.id].pass ? 'PASS' : 'FAIL'} via ${r.model || '-'} ${r.ms}ms`);
  }
  out.ladders.push(lrow);
}

const rate = (rows) => {
  const cells = rows.flatMap(r => Object.values(r.tasks));
  return { answered: cells.filter(c => c.answered).length, pass: cells.filter(c => c.pass).length, total: cells.length };
};
const summary = { runAt, quick: QUICK, ladders: out.ladders.map(l => ({ ladder: l.ladder, ...rate([l]) })), rungs: out.rungs.map(r => ({ ladder: r.ladder, rung: r.rung, ...rate([r]) })) };

fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'results/ladder-bench-latest.json'), JSON.stringify(out, null, 2) + '\n');
fs.appendFileSync(path.join(ROOT, 'results/ladder-bench-history.jsonl'), JSON.stringify(summary) + '\n');

const ids = TASKS.map(t => t.id);
const cell = (c) => (c.pass ? '✅' : c.answered ? '🟡' : '❌') + ` ${(c.ms / 1000).toFixed(1)}s`;
let md = `## LLM ladder bench — ${runAt}${QUICK ? ' (quick)' : ''}\n\n✅ pass · 🟡 answered, wrong shape · ❌ error\n\n`;
for (const l of out.ladders) {
  md += `### Ladder \`${l.ladder}\` (as clients see it)\n\n| task | result | answered by |\n|---|---|---|\n`;
  for (const id of ids) md += `| ${id} | ${cell(l.tasks[id])} | ${l.tasks[id].model || l.tasks[id].error || ''} |\n`;
  md += `\n#### Rungs of \`${l.ladder}\` (pinned, no failover)\n\n| rung | ${ids.join(' | ')} |\n|---|${ids.map(() => '---').join('|')}|\n`;
  for (const r of out.rungs.filter(x => x.ladder === l.ladder)) md += `| ${r.rung} | ${ids.map(id => cell(r.tasks[id])).join(' | ')} |\n`;
  md += '\n';
}
console.log(md);
const ladderFail = out.ladders.some(l => !l.tasks.ping?.pass || !l.tasks.json?.pass);
process.exit(ladderFail ? 1 : 0);
