/**
 * Zero-waste tool I/O benchmark.
 *
 * Measures three claims this change makes, with no simulated model in the path:
 *
 *  1. Model-facing tool results serialized as compact JSON instead of
 *     pretty-printed JSON spend fewer estimated tokens on identical information.
 *  2. The answer-only response contract strips bare pleasantries from delegated
 *     answers without touching the answer body.
 *  3. Memoizing the per-profile tool surface removes repeated rebuild work on
 *     the `tools/list` / `bridge_discover_tools` hot path.
 *
 * Token counts come from `HonestTokenizer` and are ESTIMATES (the file documents
 * an ~±5% error on code and whitespace). Byte counts are exact.
 *
 * Usage: node scripts/bench/bench-model-serialization.mjs
 */
import { ToolRegistry } from '../../src/tool-registry.js';
import { serializeModelResult } from '../../src/utils/model-serializer.js';
import { enforceResponseContract } from '../../src/protocol/response-contract.js';
import { HonestTokenizer } from '../../src/tokenizer/honest-tokenizer.js';

function tokens(text) {
  return HonestTokenizer.countTokens(text);
}

function pct(part, whole) {
  if (!whole) return 0;
  return Number(((1 - part / whole) * 100).toFixed(2));
}

// ---------------------------------------------------------------------------
// Corpus 1: representative tool results a host model actually receives.
// ---------------------------------------------------------------------------
const resultCorpus = [
  {
    label: 'bridge_discover_tools (74 tools)',
    value: new ToolRegistry().getToolDefinitions('all').map(d => ({
      name: d.name,
      description: d.description,
      category: 'core',
      effect: 'read'
    }))
  },
  {
    label: 'bridge_inspect_project (nested)',
    value: {
      ok: true,
      root: '/Users/dev/project',
      files: Array.from({ length: 40 }, (_, i) => ({
        path: `src/module-${i}/index.js`,
        size: 1024 * (i + 1),
        language: 'javascript',
        symbols: [`fn${i}`, `Class${i}`],
        lastModified: '2026-10-17T00:00:00.000Z'
      }))
    }
  },
  {
    label: 'bridge_get_events (records)',
    value: {
      events: Array.from({ length: 50 }, (_, i) => ({
        eventId: i + 1,
        type: 'response_completed',
        requestId: `req_${String(i).padStart(5, '0')}`,
        fromAgent: 'chatgpt-desktop',
        toAgent: 'claude-desktop',
        at: '2026-10-17T00:00:00.000Z'
      }))
    }
  }
];

let prettyBytesTotal = 0;
let compactBytesTotal = 0;
let prettyTokensTotal = 0;
let compactTokensTotal = 0;
const serializationRows = [];
for (const { label, value } of resultCorpus) {
  const pretty = JSON.stringify(value, null, 2);
  const compact = serializeModelResult(value);
  const pb = Buffer.byteLength(pretty, 'utf8');
  const cb = Buffer.byteLength(compact, 'utf8');
  const pt = tokens(pretty);
  const ct = tokens(compact);
  prettyBytesTotal += pb;
  compactBytesTotal += cb;
  prettyTokensTotal += pt;
  compactTokensTotal += ct;
  serializationRows.push({
    label,
    prettyBytes: pb,
    compactBytes: cb,
    byteReductionPct: pct(cb, pb),
    prettyTokensEst: pt,
    compactTokensEst: ct,
    tokenReductionPct: pct(ct, pt)
  });
}

// ---------------------------------------------------------------------------
// Corpus 2: delegated answers with realistic pleasantry wrapping.
// ---------------------------------------------------------------------------
const ANSWER_BODY =
  'The claim query scans the whole tasks table because there is no composite index on ' +
  '(status, to_agent). Add one, then re-run EXPLAIN QUERY PLAN to confirm the planner ' +
  'picks the covering index instead of the status-only index.';
const answerCorpus = [
  `Sure! Here is the answer:\n\n${ANSWER_BODY}`,
  `Certainly! ${ANSWER_BODY}\n\nHope this helps!`,
  `Got it. ${ANSWER_BODY}\n\nLet me know if you want me to open a PR for it.`,
  ANSWER_BODY
];

let answerTokensBefore = 0;
let answerTokensAfter = 0;
let answerTokensSaved = 0;
let answerStripped = 0;
for (const answer of answerCorpus) {
  const r = enforceResponseContract(answer, { answerOnly: true });
  answerTokensBefore += r.originalTokens;
  answerTokensAfter += r.finalTokens;
  answerTokensSaved += r.tokensSaved;
  if (r.applied) answerStripped++;
  if (r.text !== (answer.replace(/^Sure! /, ''))) {
    // sanity: the body must survive; only pleasantries may disappear
    if (!r.text.includes(ANSWER_BODY)) {
      console.error('FATAL: contract stripped answer body:', JSON.stringify(r.text));
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// Corpus 3: tool-surface memoization speed.
// ---------------------------------------------------------------------------
const registry = new ToolRegistry();
const ITERATIONS = 200_000;

// Warm.
for (let i = 0; i < 1000; i++) registry.getToolDefinitions('all');

const t0 = process.hrtime.bigint();
for (let i = 0; i < ITERATIONS; i++) registry.getToolDefinitions('all');
const t1 = process.hrtime.bigint();
const cachedNsPerCall = Number(t1 - t0) / ITERATIONS;

const t2 = process.hrtime.bigint();
for (let i = 0; i < ITERATIONS; i++) registry._computeToolDefinitions('all');
const t3 = process.hrtime.bigint();
const uncachedNsPerCall = Number(t3 - t2) / ITERATIONS;

const report = {
  tokenizerModel: HonestTokenizer.name,
  note: 'Token figures are estimates (HonestTokenizer), byte figures are exact.',
  modelSerialization: {
    prettyBytes: prettyBytesTotal,
    compactBytes: compactBytesTotal,
    byteReductionPct: pct(compactBytesTotal, prettyBytesTotal),
    prettyTokensEst: prettyTokensTotal,
    compactTokensEst: compactTokensTotal,
    tokenReductionPct: pct(compactTokensTotal, prettyTokensTotal),
    rows: serializationRows
  },
  responseContract: {
    cases: answerCorpus.length,
    casesStripped: answerStripped,
    tokensBeforeEst: answerTokensBefore,
    tokensAfterEst: answerTokensAfter,
    tokensSavedEst: answerTokensSaved,
    reductionPct: pct(answerTokensAfter, answerTokensBefore)
  },
  toolSurfaceMemoization: {
    iterations: ITERATIONS,
    cachedNsPerCall: Number(cachedNsPerCall.toFixed(1)),
    uncachedNsPerCall: Number(uncachedNsPerCall.toFixed(1)),
    speedupX: Number((uncachedNsPerCall / cachedNsPerCall).toFixed(1))
  }
};

console.log(JSON.stringify(report, null, 2));
