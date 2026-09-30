#!/usr/bin/env node
// ladder-bench.mjs — continuous benchmark of OUR LLM API: the trained-assist-llm-ladder worker
// (https://llm-ladder.trainedassist.store). Owner 2026-09-27: «чтобы наши апи работали, нужно
// гонять бенчмарки постоянно и смотреть что да как».
//
// Two passes, both through the worker (provider keys stay in the worker):
//   1. per rung  — every rung of every ladder pinned via `ladder_rung` (no failover): does this
//                  model answer, how fast, does the answer have the right shape?
//   2. per ladder — the ladder as clients see it (failover on): which rung answered, latency.
// Tasks: ping + JSON mode + a tool call + the 3 realistic inputs in data/avg-inputs.json.
// Quality (#5): the two code tasks are EXECUTED (temp file, `node`, timeout) against the cases
// the prompt itself promises — a keyword mention is no longer a pass; agent-plan is graded by an
// LLM judge (rung pinned `opencode-go/mimo-v2.6-flash`, rubric = `expect`) → q0–2 in the cell.
// Every rung row carries a tier icon: 💚 free / 💛 subscription / 🔴 paid, with a per-tier
// rollup on top, so "where are the free models and are they OK" is answerable at a glance.
//
// Output: results/ladder-bench-latest.json (full), results/ladder-bench-history.jsonl (one
// summary line per run), markdown summary on stdout (CI puts it in the step summary).
//
// Usage: LLM_LADDER_TOKEN=... node scripts/ladder-bench.mjs [--ladders deepseek,free] [--quick]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL_BASE = (process.env.LLM_LADDER_URL || 'https://llm-ladder.trainedassist.store').replace(/\/+$/, '');
const TOKEN = process.env.LLM_LADDER_TOKEN;
if (!TOKEN) { console.error('LLM_LADDER_TOKEN not set'); process.exit(2); }
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const QUICK = process.argv.includes('--quick');
const ONLY = arg('--ladders') ? arg('--ladders').split(',') : null;

const avg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/avg-inputs.json'), 'utf8')).inputs;


// Tier of a rung for the report: 💚 free (zen free tier, -free / :free slugs) / 💛 Go
// subscription / 🔴 paid OpenRouter. Cosmetic — but it is what makes the report readable (#5).
const tierOf = (rung) =>
  rung.startsWith('openrouter/') ? (rung.endsWith(':free') ? 'free' : 'paid')
    : rung.startsWith('opencode-zen/') ? 'free'
      : rung.endsWith('-free') ? 'free' : 'sub';
const TIER_ICON = { free: '\u{1F49A}', sub: '\u{1F49B}', paid: '\u{1F534}' }; // 💚 💛 🔴

// Code out of a model answer: fenced blocks when present, else the raw text. The runner executes
// whatever we extract — accepted risk: inputs are our own, the runner is an ephemeral CI job and
// spawnSync caps it at 6s.
function extractCode(content) {
  const blocks = [...String(content || '').matchAll(/```(?:js|javascript|cjs)?\s*\n?([\s\S]*?)```/g)].map(m => m[1]);
  return (blocks.length ? blocks.join('\n') : String(content || '')).trim();
}

function execJs(code, asserts) {
  const file = path.join(os.tmpdir(), `ladder-bench-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(file, `${code}\n${asserts}\n`);
  let r;
  try {
    r = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 6000 });
  } finally {
    fs.rmSync(file, { force: true });
  }
  if (r.error) return { ok: false, why: String(r.error.message || r.error).replace(/\s+/g, ' ').slice(0, 140) };
  if (r.signal) return { ok: false, why: `killed by ${r.signal} (6s budget)` };
  if (r.status !== 0) {
    const out = `${r.stdout || ''}${r.stderr || ''}`.replace(/\s+/g, ' ').trim();
    return { ok: false, why: (out || `exit ${r.status}`).slice(0, 140) };
  }
  return { ok: true };
}

// code-fix: the stated bug (`i <= nums.length`) is OUTPUT-INVISIBLE — the out-of-range read gives
// undefined → NaN → `NaN === 0` is false, so the sum never changes. Execution alone therefore
// cannot tell fixed from broken: run the cases (proves it works as sumEven) AND require the fix
// in the code (fixed bound or for-of), rejecting a verbatim buggy copy. Prose that quotes the bug
// next to a fixed function still passes (fixed OR !buggy).
const FIX_ASSERTS = `
if (typeof sumEven !== 'function') throw new Error('sumEven is not a function');
const __cases = [[[1,2,3,4], 6], [[1,3,5], 0], [[2,4,6], 12], [[], 0], [[-2,-1,0,3], -2]];
for (const [inp, exp] of __cases) {
  const got = sumEven(inp);
  if (got !== exp) throw new Error('sumEven(' + JSON.stringify(inp) + ') = ' + got + ', expected ' + exp);
}`;

// code-gen: every case the prompt itself promises (results, RangeError on size<1, no mutation).
const CHUNK_ASSERTS = `
if (typeof chunk !== 'function') throw new Error('chunk is not a function');
const __eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const __arr = [1,2,3,4,5];
if (!__eq(chunk(__arr, 2), [[1,2],[3,4],[5]])) throw new Error('chunk([1,2,3,4,5],2) = ' + JSON.stringify(chunk(__arr, 2)));
if (!__eq(chunk([1,2,3], 1), [[1],[2],[3]])) throw new Error('chunk([1,2,3],1) = ' + JSON.stringify(chunk([1,2,3], 1)));
if (!__eq(chunk([], 3), [])) throw new Error('chunk([],3) must be []');
if (!__eq(__arr, [1,2,3,4,5])) throw new Error('input array was mutated');
let __t = null; try { chunk([1,2], 0); } catch (e) { __t = e; }
if (!(__t instanceof RangeError)) throw new Error('chunk([1,2],0) must throw RangeError');
__t = null; try { chunk([1,2], -1); } catch (e) { __t = e; }
if (!(__t instanceof RangeError)) throw new Error('chunk([1,2],-1) must throw RangeError');`;

function checkCodeFix(m) {
  const code = extractCode(m.content);
  if (!code) return { pass: false, detail: 'no code in answer' };
  const exec = execJs(code, FIX_ASSERTS);
  const fixed = /i\s*<\s*nums\.length/.test(code) || /\bof\s+nums\b/.test(code);
  const buggy = /i\s*<=\s*nums\.length/.test(code);
  const pass = exec.ok && (fixed || !buggy);
  return { pass, detail: exec.ok ? (pass ? 'exec-ok' : 'buggy bound kept, not fixed') : `exec: ${exec.why}` };
}

function checkCodeGen(m) {
  const code = extractCode(m.content);
  if (!code) return { pass: false, detail: 'no code in answer' };
  const exec = execJs(code, CHUNK_ASSERTS);
  return { pass: exec.ok, detail: exec.ok ? 'exec-ok' : `exec: ${exec.why}` };
}

// LLM judge for the plan task: rubric = the task's own `expect`, rung pinned through the same
// worker so provider keys stay inside it. Judge unavailable → fall back to the shape check (never
// fail a rung because our judge was down); q is recorded only when the judge answered.
const JUDGE_RUNG = 'opencode-go/mimo-v2.6-flash';
async function judgePlan(taskText, expect, answer) {
  const prompt = [
    'You grade a step-by-step plan against a rubric. Reply ONLY with JSON: {"score":0|1|2,"why":"..."} (why <= 120 chars).',
    '2 = every rubric point covered by concrete steps in a workable order; 1 = covers some but misses or hand-waves key points; 0 = off-topic, not a plan, or unusable.',
    '',
    `Rubric: ${expect}`,
    '',
    'Task the plan must solve:',
    '---',
    String(taskText).slice(0, 3000),
    '---',
    'Candidate plan:',
    '---',
    String(answer || '').slice(0, 6000),
    '---',
  ].join('\n');
  try {
    const r = await call({
      model: 'deepseek',
      ladder_rung: JUDGE_RUNG,
      response_format: { type: 'json_object' },
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    }, { rung: JUDGE_RUNG, timeoutMs: 60_000 });
    if (!r.ok) return null;
    const j = JSON.parse(String(r.message.content || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    const q = Number(j.score);
    if (!(q >= 0 && q <= 2)) return null;
    return { q, why: String(j.why || '').slice(0, 160) };
  } catch {
    return null;
  }
}

async function checkPlan(m, inp) {
  const shape = (String(m.content || '').match(/^\s*\d+[.)]/gm) || []).length >= 3;
  const j = await judgePlan(inp.text, inp.expect, m.content);
  // The judge owns the verdict — the old regex misreads `**1.**` style numbering and double
  // counts with the rubric. The step-count check stays only as the fallback when the judge is down.
  if (!j) return { pass: shape, detail: shape ? 'shape only (judge unavailable)' : 'fewer than 3 numbered steps' };
  return { pass: j.q >= 1, q: j.q, detail: `q=${j.q} ${j.why}` };
}

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
      'code-fix': (m) => checkCodeFix(m),
      'code-gen': (m) => checkCodeGen(m),
      'agent-plan': (m) => checkPlan(m, inp),
    }[inp.id] || ((m) => ({ pass: !!m.content })),
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
      const v = r.ok ? await t.check(r.message) : false;
      const verdict = typeof v === 'object' && v !== null ? v : { pass: !!v };
      row.tasks[t.id] = { answered: r.ok, pass: r.ok && !!verdict.pass, ms: r.ms,
        ...(verdict.q !== undefined ? { q: verdict.q } : {}), ...(verdict.detail ? { detail: verdict.detail } : {}),
        ...(r.ok ? {} : { error: r.error }) };
      console.error(`[rung] ${l.id} ${rung} ${t.id}: ${row.tasks[t.id].pass ? 'PASS' : row.tasks[t.id].answered ? 'shape-fail' : 'ERR ' + r.error} ${r.ms}ms${verdict.detail ? ' | ' + verdict.detail : ''}`);
    }
    out.rungs.push(row);
  }
  const lrow = { ladder: l.id, tasks: {} };
  for (const t of TASKS) {
    const r = await call({ ...t.body, model: l.id });
    const v = r.ok ? await t.check(r.message) : false;
    const verdict = typeof v === 'object' && v !== null ? v : { pass: !!v };
    lrow.tasks[t.id] = { answered: r.ok, pass: r.ok && !!verdict.pass, ms: r.ms, model: r.model || null,
      ...(verdict.q !== undefined ? { q: verdict.q } : {}), ...(verdict.detail ? { detail: verdict.detail } : {}),
      ...(r.ok ? {} : { error: r.error }) };
    console.error(`[ladder] ${l.id} ${t.id}: ${lrow.tasks[t.id].pass ? 'PASS' : 'FAIL'} via ${r.model || '-'} ${r.ms}ms`);
  }
  out.ladders.push(lrow);
}

const rate = (rows) => {
  const cells = rows.flatMap(r => Object.values(r.tasks));
  return { answered: cells.filter(c => c.answered).length, pass: cells.filter(c => c.pass).length, total: cells.length };
};
// Per-tier rollup (#5): "is the free segment OK" answered without reading17 rows.
const tiers = {};
for (const r of out.rungs) {
  const t = tierOf(r.rung);
  const cells = Object.values(r.tasks);
  tiers[t] = tiers[t] || { rungs: 0, all_green: 0, ping_sum_ms: 0, ping_n: 0 };
  tiers[t].rungs += 1;
  if (cells.length && cells.every(c => c.pass)) tiers[t].all_green += 1;
  if (cells[0]) { tiers[t].ping_sum_ms += cells[0].ms; tiers[t].ping_n += 1; }
}
const summary = { runAt, quick: QUICK, tiers, ladders: out.ladders.map(l => ({ ladder: l.ladder, ...rate([l]) })), rungs: out.rungs.map(r => ({ ladder: r.ladder, rung: r.rung, ...rate([r]) })) };

fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'results/ladder-bench-latest.json'), JSON.stringify(out, null, 2) + '\n');
fs.appendFileSync(path.join(ROOT, 'results/ladder-bench-history.jsonl'), JSON.stringify(summary) + '\n');

const ids = TASKS.map(t => t.id);
const cell = (c) => (c.pass ? '✅' : c.answered ? '🟡' : '❌') + ` ${(c.ms / 1000).toFixed(1)}s` + (c.q !== undefined ? ` ·q${c.q}` : '');
let md = `## LLM ladder bench — ${runAt}${QUICK ? ' (quick)' : ''}\n\n`
  + `✅ pass · 🟡 answered, wrong shape · ❌ error · q0–2 = качество по рубрике (судья) · 💚 free · 💛 подписка · 🔴 paid\n\n`;
const tierName = { free: '💚 free', sub: '💛 подписка (Go)', paid: '🔴 paid' };
md += `| tier | рунги | все задачи ✅ | avg ping |\n|---|---|---|---|\n`;
for (const t of ['free', 'sub', 'paid']) {
  const x = tiers[t];
  if (!x) continue;
  md += `| ${tierName[t]} | ${x.rungs} | ${x.all_green}/${x.rungs} | ${x.ping_n ? (x.ping_sum_ms / x.ping_n / 1000).toFixed(1) + 's' : '—'} |\n`;
}
md += '\n';
for (const l of out.ladders) {
  md += `### Ladder \`${l.ladder}\` (as clients see it)\n\n| task | result | answered by |\n|---|---|---|\n`;
  for (const id of ids) {
    const m = l.tasks[id].model;
    md += `| ${id} | ${cell(l.tasks[id])} | ${m ? TIER_ICON[tierOf(m)] + ' ' + m : (l.tasks[id].error || '')} |\n`;
  }
  md += `\n#### Rungs of \`${l.ladder}\` (pinned, no failover)\n\n| rung | ${ids.join(' | ')} |\n|---|${ids.map(() => '---').join('|')}|\n`;
  for (const r of out.rungs.filter(x => x.ladder === l.ladder)) md += `| ${TIER_ICON[tierOf(r.rung)]} ${r.rung} | ${ids.map(id => cell(r.tasks[id])).join(' | ')} |\n`;
  md += '\n';
}
console.log(md);
const ladderFail = out.ladders.some(l => !l.tasks.ping?.pass || !l.tasks.json?.pass);
process.exit(ladderFail ? 1 : 0);
