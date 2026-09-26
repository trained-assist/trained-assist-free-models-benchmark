#!/usr/bin/env node
// Free/cheap model benchmark harness for trained-assist executor roles.
// Reads research/bench-tasks.json, runs each build on each task, applies the
// declared check, and writes research/results.json (incrementally) +
// research/spend.json (paid-call ledger).
//
// Builds:
//   B1 single free model        — baseline
//   B2 free ensemble (families) — N independent answers; Hermes arbitrates
//   B3 Hermes critique loop     — frame -> answer -> critique -> revise
//   B4 free->paid fallback chain— free first, hard-capped cheap paid on error
//
// Usage: OPENROUTER_API_KEY=... node research/run-bench.mjs [--fresh]
// Env:   BENCH_BUILDS=B1,B2  BENCH_TASKS=t01,t02  BENCH_LIMIT=2  PAID_CAP_USD=2

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TASKS_FILE = path.join(__dirname, 'bench-tasks.json');
const RESULTS_FILE = path.join(__dirname, 'results.json');
const SPEND_FILE = path.join(__dirname, 'spend.json');
const MODELS_FILE = path.join(__dirname, 'openrouter-free-models.json');

const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY) { console.error('OPENROUTER_API_KEY not set'); process.exit(1); }

const PAID_CAP_USD = Number(process.env.PAID_CAP_USD || 2);
const FRESH = process.argv.includes('--fresh');
const LIMIT = process.env.BENCH_LIMIT ? Number(process.env.BENCH_LIMIT) : Infinity;
const ONLY_BUILDS = process.env.BENCH_BUILDS ? process.env.BENCH_BUILDS.split(',').map(s => s.trim()) : null;
const ONLY_TASKS = process.env.BENCH_TASKS ? process.env.BENCH_TASKS.split(',').map(s => s.trim()) : null;

// ── Model configuration ───────────────────────────────────────────────────────
const NEMOTRON_ULTRA = 'nvidia/nemotron-3-ultra-550b-a55b:free';
const NEMOTRON_FAST  = 'nvidia/nemotron-3.5-lightning:free';
// "Space Bunny Free" (brief Step 3) resolves to stealth/space-bunny-alpha: a
// free-priced (cost 0) 1M-ctx stealth model with no public model card.
const SPACE_BUNNY    = 'stealth/space-bunny-alpha';

// One entry per family; each family lists models in preference order so a
// rate-limited (429) / forbidden (403) model degrades to the next in-family.
const FAMILIES = {
  nvidia:     [NEMOTRON_ULTRA, NEMOTRON_FAST, 'nvidia/nemotron-3-super-120b-a12b:free'],
  google:     ['google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free'],
  alibaba:    ['qwen/qwen3.8-27b:free'],
  inclusionai:[ 'inclusionai/ling-3.0-flash-sante:free', 'inclusionai/ling-3.0-flash-fin:free'],
  cohere:     ['cohere/north-mini-code:free'],
  poolside:   ['poolside/laguna-s-2.1:free'],
};
// B2 ensemble: three DIFFERENT families (nvidia + google + alibaba per brief,
// with inclusionai/cohere/poolside as live substitutes when a family is down).
const ENSEMBLE_FAMILIES = ['nvidia', 'google', 'alibaba', 'inclusionai', 'cohere'];
// B3 solver pool — non-nvidia families so the solver != the Hermes framer.
const SOLVER_CHAIN = ['inclusionai/ling-3.0-flash-sante:free', 'cohere/north-mini-code:free', 'poolside/laguna-s-2.1:free', 'dots-studio/dots-3-note-preview:free'];

const PAID_FALLBACK = [
  { model: 'deepseek/deepseek-chat',           timeoutMs: 60_000 },
  { model: 'google/gemini-flash-1.5-8b',       timeoutMs: 60_000 },
  { model: 'openai/gpt-4o-mini',               timeoutMs: 60_000 },
];

const JUDGE_MODEL = NEMOTRON_FAST;
const DEFAULT_MAX_TOKENS = 2000;
const DEFAULT_TIMEOUT_MS = 120_000;

// ── Spend ledger ──────────────────────────────────────────────────────────────
const spend = { cap_usd: PAID_CAP_USD, total_usd: 0, paid_calls: [], aborted: false };
function loadSpend() {
  try {
    const prev = JSON.parse(fs.readFileSync(SPEND_FILE, 'utf8'));
    if (Array.isArray(prev.paid_calls)) {
      spend.paid_calls = prev.paid_calls;
      spend.total_usd = prev.total_usd || 0;
    }
  } catch { /* none yet */ }
}
function saveSpend() {
  fs.writeFileSync(SPEND_FILE, JSON.stringify(spend, null, 2) + '\n');
}
function recordPaid(model, usage, costUsd, note) {
  spend.paid_calls.push({ model, tokens: usage?.total_tokens ?? null, cost_usd: Number(costUsd.toFixed(6)), note, at: new Date().toISOString() });
  spend.total_usd = Number((spend.total_usd + costUsd).toFixed(6));
  if (spend.total_usd >= PAID_CAP_USD) spend.aborted = true;
  saveSpend();
}

// ── Pricing discovery (for paid cost estimation when usage.cost is absent) ─────
let priceMap = {};
async function loadPricing() {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', { headers: { Authorization: `Bearer ${API_KEY}` }, signal: AbortSignal.timeout(15_000) });
    const { data = [] } = await res.json();
    for (const m of data) {
      const p = m.pricing || {};
      priceMap[m.id] = { prompt: Number(p.prompt || 0), completion: Number(p.completion || 0) };
    }
    console.error(`[bench] pricing loaded for ${Object.keys(priceMap).length} models`);
  } catch (e) { console.error(`[bench] pricing load failed: ${e.message}`); }
}
function estimateCost(model, usage) {
  if (usage?.cost != null) return Number(usage.cost);
  const p = priceMap[model];
  if (!p || !usage) return 0;
  return (usage.prompt_tokens || 0) * p.prompt + (usage.completion_tokens || 0) * p.completion;
}

// ── OpenRouter call ───────────────────────────────────────────────────────────
// Transient upstream failures (empty body / empty content / 429 / 403 / 5xx /
// timeout) are retried up to BENCH_RETRIES times — a real executor retries. The
// number of transient failures is still recorded so reliability stays visible.
const RETRIES = Math.max(1, Number(process.env.BENCH_RETRIES || 2));
const callLog = [];
let invocations = 0;
let flushedCalls = 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Append only not-yet-persisted call entries (avoids duplication across phases).
function flushCalls(results) {
  const fresh = callLog.slice(flushedCalls);
  flushedCalls = callLog.length;
  const at = new Date().toISOString();
  results.calls_log = [...(results.calls_log || []), ...fresh.map(c => ({ ...c, run: at }))];
  return fresh.length;
}

async function callOnce(model, messages, opts) {
  const { maxTokens = DEFAULT_MAX_TOKENS, temperature = 0, timeoutMs = DEFAULT_TIMEOUT_MS, jsonMode = false } = opts;
  const body = { model, messages, temperature, max_tokens: maxTokens };
  if (jsonMode) body.response_format = { type: 'json_object' };
  const t0 = Date.now();
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - t0;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || `HTTP ${res.status}`;
      return { ok: false, model, latencyMs, error: msg.slice(0, 200), status: res.status, usage: null, costUsd: 0, text: '' };
    }
    const text = (data?.choices?.[0]?.message?.content || '').trim();
    const finishReason = data?.choices?.[0]?.finish_reason || null;
    const usage = data?.usage || null;
    const costUsd = estimateCost(model, usage);
    if (!text) return { ok: false, model, latencyMs, error: 'empty content', status: res.status, usage, costUsd, text: '', finishReason };
    return { ok: true, model, latencyMs, text, usage, costUsd, finishReason };
  } catch (e) {
    const latencyMs = Date.now() - t0;
    const err = e.name === 'TimeoutError' ? `timeout ${timeoutMs}ms` : e.message;
    return { ok: false, model, latencyMs, error: err, status: null, usage: null, costUsd: 0, text: '' };
  }
}

async function callModel(model, messages, opts = {}) {
  invocations++;
  let r, attempts = 0;
  for (let i = 0; i < RETRIES; i++) {
    attempts++;
    r = await callOnce(model, messages, opts);
    callLog.push({ model, latencyMs: r.latencyMs, ok: r.ok, status: r.status ?? null, tokens: r.usage?.total_tokens ?? null, costUsd: Number((r.costUsd || 0).toFixed(6)), error: r.ok ? null : r.error, attempt: attempts, finishReason: r.finishReason || null });
    if (r.ok) break;
    if (i < RETRIES - 1) await sleep(1200 + i * 800);
  }
  return { ...r, attempts };
}

// Try a chain of models; return first success, else last error result.
async function callWithFallback(models, messages, opts = {}) {
  let last;
  for (const m of models) {
    const r = await callModel(m, messages, opts);
    if (r.ok) return r;
    last = r;
    console.error(`[bench]   ${m} -> ${r.error}`);
  }
  return last || { ok: false, error: 'no models', model: null };
}

// ── Hermes structured-JSON helper (mirrors src/hermes-run.js contract) ────────
function parseLlmJson(raw) {
  if (!raw) return null;
  let s = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/,'').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try { return JSON.parse(s); } catch { return null; }
}
async function hermesJson(models, task, context, schema, opts = {}) {
  const messages = [
    { role: 'system', content: 'You are Hermes, a research worker. Reply with ONLY valid JSON matching the requested schema — no markdown fences, no prose outside the JSON.' },
    { role: 'user', content: `Task:\n${task}\n\nContext:\n${context || '(none)'}\n\nResponse schema (JSON):\n${JSON.stringify(schema, null, 2)}` },
  ];
  const r = await callModel(Array.isArray(models) ? models[0] : models, messages, { maxTokens: opts.maxTokens || 1500, temperature: 0.2, jsonMode: true, timeoutMs: opts.timeoutMs });
  if (!r.ok) return { ok: false, error: r.error, raw: r.text, latencyMs: r.latencyMs, model: r.model, usage: r.usage, costUsd: r.costUsd || 0 };
  return { ok: true, json: parseLlmJson(r.text), raw: r.text, latencyMs: r.latencyMs, model: r.model, usage: r.usage, costUsd: r.costUsd || 0 };
}

// ── Checks ────────────────────────────────────────────────────────────────────
function stripFences(s) { return String(s || '').replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim(); }
function normText(s) { return stripFences(s).toLowerCase().replace(/\s+/g, ' ').trim(); }
function firstNumber(s) { const m = String(s).match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : NaN; }

function checkExact(output, ref, task) {
  if (task.normalize === 'number') {
    const got = firstNumber(output);
    const want = Number(ref);
    const pass = Number.isFinite(got) && got === want;
    return { pass, detail: `got=${got} want=${want}` };
  }
  const pass = normText(output) === normText(ref);
  return { pass, detail: pass ? 'exact match' : `got="${normText(output).slice(0,80)}"` };
}
function checkContains(output, refs) {
  const hay = normText(output);
  const missing = refs.filter(r => !hay.includes(normText(r)));
  return { pass: missing.length === 0, detail: missing.length ? `missing: ${missing.join(', ')}` : `all ${refs.length} present` };
}
function extractJson(output) {
  let s = stripFences(output);
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try { return JSON.parse(s); } catch { return null; }
}
function checkSchema(output, ref) {
  const obj = extractJson(output);
  if (!obj || typeof obj !== 'object') return { pass: false, detail: 'not valid JSON object' };
  const missing = (ref.required || []).filter(k => obj[k] == null || String(obj[k]).trim() === '');
  const wrong = [];
  for (const [k, v] of Object.entries(ref.expect || {})) {
    if (obj[k] == null || normText(obj[k]) !== normText(v)) wrong.push(`${k}="${obj[k]}"`);
  }
  const pass = missing.length === 0 && wrong.length === 0;
  return { pass, detail: pass ? 'schema+values ok' : [missing.length && `missing: ${missing.join(',')}`, wrong.length && `wrong: ${wrong.join(',')}`].filter(Boolean).join('; ') };
}
function checkTest(output, task) {
  const code = stripFences(output);
  if (!code) return { pass: false, detail: 'no code in output' };
  try {
    const ctx = vm.createContext({ console: { log() {}, error() {} } });
    const result = vm.runInContext(`${code}\n;${task.harness}`, ctx, { timeout: 3000 });
    return { pass: result === true, detail: `harness returned ${JSON.stringify(result)}` };
  } catch (e) {
    return { pass: false, detail: `runtime error: ${String(e.message).slice(0, 120)}` };
  }
}
async function checkJudge(output, task) {
  const schema = { pass: 'boolean (true if the answer correctly identifies the main risk)', reason: 'short string' };
  const r = await hermesJson([JUDGE_MODEL], 'Judge whether the candidate answer satisfies the rubric. Be strict but fair.', `Rubric:\n${task.reference}\n\nCandidate answer:\n${output}\n\nJSON schema:\n${JSON.stringify(schema)}`, schema, { maxTokens: 2500 });
  if (!r.ok || !r.json || typeof r.json.pass !== 'boolean') {
    return { pass: false, detail: `judge failed: ${r.error || 'unparsable'}`, judge: true, judgeModel: r.model || JUDGE_MODEL };
  }
  return { pass: r.json.pass, detail: `judge: ${String(r.json.reason || '').slice(0, 160)}`, judge: true, judgeModel: r.model, judgeUsage: r.usage, judgeCostUsd: r.costUsd };
}

async function applyCheck(output, task) {
  switch (task.check) {
    case 'exact': return checkExact(output, task.reference, task);
    case 'contains': return checkContains(output, task.reference);
    case 'schema': return checkSchema(output, task.reference);
    case 'test': return checkTest(output, task);
    case 'judge': return await checkJudge(output, task);
    default: return { pass: false, detail: `unknown check ${task.check}` };
  }
}

// ── Builds ────────────────────────────────────────────────────────────────────
async function b4Resolve(messages, opts, build, note) {
  // free-first chain, cheap-paid fallback on error, hard cap.
  const free = Object.values(FAMILIES).flat();
  const freeRes = await callWithFallback(free, messages, opts);
  if (freeRes.ok) return { result: freeRes, usedPaid: false, freeErrors: callLog.slice(-free.length).filter(c => !c.ok).length };
  // paid fallback
  for (const p of PAID_FALLBACK) {
    if (spend.aborted || spend.total_usd >= PAID_CAP_USD) {
      console.error(`[bench] PAID CAP hit ($${spend.total_usd}) — aborting paid fallback`);
      break;
    }
    const r = await callModel(p.model, messages, { ...opts, timeoutMs: p.timeoutMs });
    if (r.usage || r.costUsd) recordPaid(p.model, r.usage, r.costUsd, note);
    if (r.ok) return { result: r, usedPaid: true };
  }
  return { result: freeRes, usedPaid: false, paidExhausted: true };
}

async function runB1(task) {
  const messages = [{ role: 'user', content: task.prompt }];
  const r = await callModel(NEMOTRON_ULTRA, messages, { maxTokens: DEFAULT_MAX_TOKENS });
  return { output: r.text, calls: 1, primaryModel: NEMOTRON_ULTRA, latencyMs: r.latencyMs, tokens: r.usage?.total_tokens ?? null, costUsd: r.costUsd || 0, error: r.ok ? null : r.error };
}

async function runB2(task) {
  const messages = [{ role: 'user', content: task.prompt }];
  const answers = [];
  const memberResults = [];
  for (const fam of ENSEMBLE_FAMILIES) {
    const r = await callWithFallback(FAMILIES[fam], messages, { maxTokens: DEFAULT_MAX_TOKENS });
    memberResults.push({ family: fam, model: r.model, ok: r.ok, error: r.error || null, text: r.text || '', latencyMs: r.latencyMs, tokens: r.usage?.total_tokens ?? null });
    if (r.ok) answers.push({ family: fam, model: r.model, text: r.text });
  }
  const latencyMs = memberResults.reduce((a, m) => a + (m.latencyMs || 0), 0);
  const totalTokens = memberResults.reduce((a, m) => a + (m.tokens || 0), 0);
  const totalCost = memberResults.length ? 0 : 0;
  if (answers.length === 0) return { output: '', calls: memberResults.length, members: memberResults, agreement: false, arbitrated: false, error: 'all ensemble members failed', latencyMs, tokens: totalTokens, costUsd: totalCost };

  const distinct = new Set(answers.map(a => normText(a.text)));
  let agreement = distinct.size === 1;
  let chosen = answers[0].text;
  let arbitrated = false;
  let hermes = null;

  if (answers.length >= 2 && !agreement) {
    arbitrated = true;
    const schema = { best_index: 'integer index (0-based) of the most correct answer', reasoning: 'one sentence' };
    hermes = await hermesJson([NEMOTRON_ULTRA], 'Choose the single most correct candidate answer for the task.', `Task:\n${task.prompt}\n\nCandidates:\n${answers.map((a, i) => `[${i}] (${a.family}) ${a.text.slice(0, 1200)}`).join('\n\n')}`, schema, { maxTokens: 1200 });
    const idx = hermes?.json?.best_index;
    if (Number.isInteger(idx) && answers[idx]) chosen = answers[idx].text;
  }
  const chosenMember = answers.find(a => a.text === chosen) || answers[0];
  return {
    output: chosen, calls: memberResults.length + (arbitrated ? 1 : 0), members: memberResults,
    agreement, arbitrated, hermesReasoning: hermes?.json?.reasoning || null,
    primaryModel: chosenMember.model, latencyMs, tokens: totalTokens + (hermes?.usage?.total_tokens || 0),
    costUsd: totalCost, error: null,
  };
}

async function runB3(task) {
  let calls = 0, tokens = 0, latencyMs = 0;
  // 1. Hermes frames challenge questions
  const frameSchema = { questions: ['3 short, sharp questions that stress-test the answer'] };
  const frame = await hermesJson([NEMOTRON_ULTRA], 'Frame challenge questions that would expose mistakes in an answer to the task.', `Task:\n${task.prompt}`, frameSchema, { maxTokens: 800 });
  calls += 1; tokens += frame.usage?.total_tokens || 0; latencyMs += frame.latencyMs || 0;
  const questions = Array.isArray(frame?.json?.questions) && frame.json.questions.length ? frame.json.questions : ['Is the answer fully correct?', 'Does it miss an edge case?', 'Is the format exactly as requested?'];

  // 2. Solver answers with the framing in mind
  const sevenv = { role: 'user', content: `${task.prompt}\n\nAlso make sure your answer addresses:\n- ${questions.join('\n- ')}` };
  const a1 = await callWithFallback(SOLVER_CHAIN, [sevenv], { maxTokens: DEFAULT_MAX_TOKENS });
  calls += 1; tokens += a1.usage?.total_tokens || 0; latencyMs += a1.latencyMs || 0;
  const answer1 = a1.ok ? a1.text : '';

  // 3. Hermes critiques from another angle
  const critSchema = { has_errors: 'boolean', critique: 'specific problems, if any', corrected_hint: 'one concrete correction to apply' };
  const critique = await hermesJson([NEMOTRON_ULTRA], 'Critique the candidate answer for correctness, completeness and format. Be adversarial.', `Task:\n${task.prompt}\n\nCandidate answer:\n${answer1}`, critSchema, { maxTokens: 1000 });
  calls += 1; tokens += critique.usage?.total_tokens || 0; latencyMs += critique.latencyMs || 0;

  // 4. Solver revises
  let answer2 = '';
  if (answer1) {
    const reviseMsg = { role: 'user', content: `${task.prompt}\n\nYour previous answer:\n${answer1}\n\nA reviewer said:\n${critique?.json ? JSON.stringify(critique.json) : (critique.error || 'review unavailable')}\n\nNow give the corrected final answer only.` };
    const a2 = await callWithFallback(SOLVER_CHAIN, [reviseMsg], { maxTokens: DEFAULT_MAX_TOKENS });
    calls += 1; tokens += a2.usage?.total_tokens || 0; latencyMs += a2.latencyMs || 0;
    answer2 = a2.ok ? a2.text : '';
  }
  const final = answer2 || answer1;
  return {
    output: final, calls, solverModel: a1.model || null,
    frameQuestions: questions, critique: critique?.json || null, critiqueError: critique.ok ? null : critique.error,
    revised: !!answer2, firstAnswer: answer1, latencyMs, tokens, costUsd: 0,
    error: final ? null : 'no answer produced',
  };
}

async function runB4(task) {
  const messages = [{ role: 'user', content: task.prompt }];
  const before = invocations;
  const { result, usedPaid } = await b4Resolve(messages, { maxTokens: DEFAULT_MAX_TOKENS }, 'B4', `${task.id} fallback`);
  return { output: result.text || '', calls: invocations - before, usedPaid, primaryModel: result.model, latencyMs: result.latencyMs, tokens: result.usage?.total_tokens ?? null, costUsd: result.costUsd || 0, error: result.ok ? null : result.error };
}
function freeChainLen() { return Object.values(FAMILIES).flat().length; }

async function runB5(task) {
  const messages = [{ role: 'user', content: task.prompt }];
  const r = await callModel(SPACE_BUNNY, messages, { maxTokens: DEFAULT_MAX_TOKENS });
  return { output: r.text, calls: 1, primaryModel: SPACE_BUNNY, latencyMs: r.latencyMs, tokens: r.usage?.total_tokens ?? null, costUsd: r.costUsd || 0, error: r.ok ? null : r.error };
}

const BUILD_RUNNERS = { B1: runB1, B2: runB2, B3: runB3, B4: runB4, B5: runB5 };
const BUILD_DESC = {
  B1: `single free model (${NEMOTRON_ULTRA})`,
  B2: `free ensemble across families (${ENSEMBLE_FAMILIES.join('+')}), Hermes arbitrates disagreement`,
  B3: 'Hermes critique loop: frame challenges -> solve -> Hermes critiques -> revise',
  B4: `free-first chain (${freeChainLen()} models) -> cheap paid fallback (cap $${PAID_CAP_USD})`,
  B5: `single free stealth model (${SPACE_BUNNY}) — the "Space Bunny Free" evaluation`,
};

// ── Per-model reliability probe (Step 3 discovery) ────────────────────────────
// Fires PROBE_ATTEMPTS trivial calls at every free model and records success /
// status per attempt. This is the authoritative source for free-model
// availability claims — 429 / 403 / empty-content are recorded as results.
async function runProbe(results, write) {
  let models = [];
  try { models = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8')).map(m => m.id); } catch { /* none */ }
  const attempts = Math.max(1, Number(process.env.PROBE_ATTEMPTS || 3));
  console.error(`\n[bench] ===== PROBE: ${models.length} free models x ${attempts} attempts =====`);
  const out = {};
  for (const model of models) {
    out[model] = { attempts: [], ok: 0, fail: 0, statuses: {}, success_rate: 0 };
    for (let i = 0; i < attempts; i++) {
      const r = await callModel(model, [{ role: 'user', content: 'Reply with only the word: OK' }], { maxTokens: 40, temperature: 0, timeoutMs: 60_000 });
      out[model].attempts.push({ ok: r.ok, status: r.status ?? null, error: r.ok ? null : r.error, latencyMs: r.latencyMs });
      if (r.ok) out[model].ok++; else { out[model].fail++; out[model].statuses[r.status ?? 'network'] = (out[model].statuses[r.status ?? 'network'] || 0) + 1; }
    }
    out[model].success_rate = Number((out[model].ok / attempts).toFixed(3));
    console.error(`[bench]   ${model}: ${out[model].ok}/${attempts} | ${JSON.stringify(out[model].statuses)}`);
  }
  results.model_probe = { generated_at: new Date().toISOString(), attempts_per_model: attempts, models: out };
  results.model_probes = [...(results.model_probes || []), results.model_probe];
  flushCalls(results);
  write();
  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  await loadPricing();
  loadSpend();
  const taskFile = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  let tasks = taskFile.tasks;
  if (ONLY_TASKS) tasks = tasks.filter(t => ONLY_TASKS.includes(t.id));
  tasks = tasks.slice(0, LIMIT);
  let builds = Object.keys(BUILD_RUNNERS);
  if (ONLY_BUILDS) builds = builds.filter(b => ONLY_BUILDS.includes(b));

  let results = { generated_at: new Date().toISOString(), builds: {}, tasks: {}, summary: {} };
  if (!FRESH) { try { results = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8')); } catch { /* new */ } }
  results.generated_at = new Date().toISOString();
  results.build_descriptions = BUILD_DESC;
  results.paid_cap_usd = PAID_CAP_USD;

  for (const id of tasks.map(t => t.id)) results.tasks[id] = results.tasks[id] || {};
  const write = () => fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2) + '\n');

  if (process.env.BENCH_PROBE) {
    await runProbe(results, write);
    if (process.env.BENCH_ONLY_PROBE) { console.error('[bench] probe only — done'); return; }
  }

  for (const build of builds) {
    results.builds[build] = results.builds[build] || { description: BUILD_DESC[build], runs: {} };
    for (const task of tasks) {
      const key = task.id;
      const prior = results.builds[build].runs?.[key];
      if (!FRESH && prior && prior.output) { console.error(`[bench] ${build}/${key} cached`); continue; }
      console.error(`\n[bench] ===== ${build} :: ${key} (${task.check}) =====`);
      const t0 = Date.now();
      let run;
      try { run = await BUILD_RUNNERS[build](task); }
      catch (e) { run = { output: '', error: `build crash: ${e.message}`, calls: 0, latencyMs: Date.now() - t0 }; }
      const verdict = await applyCheck(run.output, task);
      const record = {
        task: key, build, check: task.check, deterministic: task.check !== 'judge',
        output: run.output ?? '', verdict: verdict.pass ? 'pass' : 'fail',
        verdict_kind: verdict.judge ? 'judge' : 'deterministic',
        detail: verdict.detail || '', judge_model: verdict.judgeModel || null,
        error: run.error || null, calls: run.calls ?? null,
        latency_ms: run.latencyMs ?? (Date.now() - t0), tokens: run.tokens ?? null, cost_usd: run.costUsd ?? 0,
        meta: run,
      };
      results.builds[build].runs[key] = record;
      results.tasks[key] = { id: key, check: task.check, deterministic: task.check !== 'judge', prompt: task.prompt };
      console.error(`[bench] -> ${record.verdict_kind}:${record.verdict}  (${record.detail})`);
      write();
    }
  }

  // Summary: keep deterministic and judge scores strictly separate.
  const sum = {};
  for (const build of Object.keys(results.builds)) {
    const runs = Object.values(results.builds[build].runs || {});
    const det = runs.filter(r => r.deterministic);
    const jdg = runs.filter(r => !r.deterministic);
    sum[build] = {
      deterministic_pass: det.filter(r => r.verdict === 'pass').length,
      deterministic_total: det.length,
      deterministic_rate: det.length ? Number((det.filter(r => r.verdict === 'pass').length / det.length).toFixed(3)) : null,
      judge_pass: jdg.filter(r => r.verdict === 'pass').length,
      judge_total: jdg.length,
      errors: runs.filter(r => r.error).length,
      total_latency_ms: runs.reduce((a, r) => a + (r.latency_ms || 0), 0),
      total_tokens: runs.reduce((a, r) => a + (r.tokens || 0), 0),
      total_cost_usd: Number(runs.reduce((a, r) => a + (r.cost_usd || 0), 0).toFixed(6)),
      calls: runs.reduce((a, r) => a + (r.calls || 0), 0),
    };
  }
  results.summary = sum;
  // Persist this run's call log (not-yet-flushed entries) for reliability analysis.
  flushCalls(results);
  results.spend = { cap_usd: PAID_CAP_USD, total_usd: spend.total_usd, paid_calls: spend.paid_calls.length, aborted: spend.aborted };
  saveSpend();
  write();

  console.error('\n[bench] ===== SUMMARY =====');
  for (const [b, s] of Object.entries(sum)) console.error(`${b}: det ${s.deterministic_pass}/${s.deterministic_total} | judge ${s.judge_pass}/${s.judge_total} | err ${s.errors} | ${s.total_tokens} tok | $${s.total_cost_usd}`);
  console.error(`\n[bench] results -> ${RESULTS_FILE}\n[bench] spend   -> ${SPEND_FILE} ($${spend.total_usd}/$${PAID_CAP_USD})`);
}
main().catch(e => { console.error('[bench] fatal', e); process.exit(1); });
