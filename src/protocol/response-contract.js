import { HonestTokenizer } from '../tokenizer/honest-tokenizer.js';

/**
 * Answer-Only Response Contract (Mission M3)
 *
 * A delegated request may carry a response contract that the responder is
 * expected to honour: answer only — no preamble, no apology, no sign-off.
 *
 * The bridge enforces the *cheap, deterministic* half of that contract at the
 * settlement boundary: leading bare pleasantries and trailing offers of help are
 * stripped so the requester's model does not pay input tokens to read
 * "Sure! Here's the answer:" before a one-line fact.
 *
 * Safety invariants (must never regress):
 *  1. Deterministic only. No model call, no network, no random behaviour.
 *  2. Closed grammar. A prefix is stripped only when it matches a *bare
 *     pleasantry* pattern — a short, complete opening segment with no technical
 *     content. Unknown or content-bearing text is never removed.
 *  3. Non-trivial remainder. Nothing is stripped unless the remaining answer is
 *     still substantial (>= `minRemainingWords`, default 30), so a terse but
 *     genuine answer is never erased.
 *  4. Code-safe. Only the outer edge of the text is considered; fenced code
 *     blocks, indentation, and trailing whitespace inside the body are untouched.
 *  5. Non-destructive accounting. The full `charsSaved`/`tokensSaved` delta is
 *     reported and the original length is always returned, so the removal is
 *     auditable rather than silent.
 *
 * A contract violation never fails the request and never truncates the answer;
 * `maxWords` and `format` are *reported*, not enforced destructively.
 */

export const DEFAULT_MIN_REMAINING_WORDS = 30;

/**
 * Leading "bare pleasantry" openers. Each pattern must consume a complete
 * opening segment (terminated by end-of-line or a colon) and must not be able to
 * swallow technical content, because `_isBarePleasantry` additionally caps the
 * matched segment length.
 */
const LEADING_FILLERS = Object.freeze([
  // Bare interjections. Requires sentence punctuation after the interjection,
  // which is what stops "Certainly not — that fails" from degrading into "not —
  // that fails": the negating continuation carries no punctuation of its own.
  /^(?:sure|certainly|of course|absolutely|no problem|got it|understood|sounds good|great|okay|ok)\b\s*[!.,:;\-]+\s*/i,
  /^(?:happy to help|i'd be happy to help|i would be happy to help|glad to help)\b\s*[!.,:;\-]+\s*/i,
  /^here(?:'s| is)\s+(?:the|my|your|a)\s+(?:answer|response|result|results|solution|breakdown|summary|analysis|implementation|explanation|code|updated[^\n:.]*|final[^\n:.]*)\s*[:.\-]?\s*(?:\n+|$)/i,
  /^(?:please find|below is|the following is|following is)[^\n]{0,60}?[:.]\s*(?:\n+|$)/i,
  /^(?:thanks?|thank you)\b[^\n]{0,40}?[.!]\s*(?:\n+|$)/i,
  /^i(?:'ll| will)\s+[^\n]{0,60}?[:.]\s*(?:\n+|$)/i
]);

/**
 * Trailing "offer of further help" closers.
 */
const TRAILING_FILLERS = Object.freeze([
  /\n*\s*(?:hope (?:this|that) helps|let me know if[^\n]{0,140}|feel free to[^\n]{0,140}|would you like me to[^\n]{0,140}\?|i can (?:also )?[^\n]{0,140} if you(?:'d| would) like[^\n]{0,100})[.!?]*\s*$/i
]);

/** Maximum word count for a segment to still count as "bare pleasantry". */
const MAX_FILLER_WORDS = 14;

const WORD_RE = /[A-Za-z0-9][A-Za-z0-9'’\-]*/g;

/**
 * Count words in a text (identifier-aware, unicode-punctuation tolerant).
 * @param {string} text
 * @returns {number}
 */
export function countWords(text) {
  if (!text || typeof text !== 'string') return 0;
  const matches = text.match(WORD_RE);
  return matches ? matches.length : 0;
}

function _isBarePleasantry(segment) {
  if (!segment) return false;
  return countWords(segment) <= MAX_FILLER_WORDS;
}

/**
 * Normalize a contract argument into a predictable shape.
 *
 * Accepts `true` (shorthand for `{ answerOnly: true }`), an object, or nothing.
 *
 * @param {boolean|object|null|undefined} contract
 * @returns {{ answerOnly: boolean, forbidPreamble: boolean, maxWords: number|null, format: string|null, minRemainingWords: number }}
 */
export function normalizeContract(contract) {
  if (contract === true) {
    return {
      answerOnly: true,
      forbidPreamble: true,
      maxWords: null,
      format: null,
      minRemainingWords: DEFAULT_MIN_REMAINING_WORDS
    };
  }
  const c = (contract && typeof contract === 'object') ? contract : {};
  const minRemaining = Number.isFinite(Number(c.minRemainingWords))
    ? Math.max(0, Number(c.minRemainingWords))
    : DEFAULT_MIN_REMAINING_WORDS;
  return {
    answerOnly: Boolean(c.answerOnly),
    forbidPreamble: Boolean(c.forbidPreamble),
    maxWords: Number.isFinite(Number(c.maxWords)) && Number(c.maxWords) > 0 ? Number(c.maxWords) : null,
    format: typeof c.format === 'string' ? c.format.toLowerCase() : null,
    minRemainingWords: minRemaining
  };
}

/**
 * Deterministically strip a leading bare pleasantry and/or trailing offer of
 * help from an answer.
 *
 * @param {string} text
 * @param {{ minRemainingWords?: number }} [options]
 * @returns {{ text: string, removedLeading: string[], removedTrailing: string[] }}
 */
export function stripPreambleAndTrailer(text, options = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    return { text, removedLeading: [], removedTrailing: [] };
  }
  const minRemainingWords = Number.isFinite(Number(options.minRemainingWords))
    ? Math.max(0, Number(options.minRemainingWords))
    : DEFAULT_MIN_REMAINING_WORDS;

  const removedLeading = [];
  const removedTrailing = [];
  let current = text;

  // Leading: strip repeated bare-pleasantry openers, bounded to avoid runaway.
  for (let i = 0; i < LEADING_FILLERS.length * 2; i++) {
    const pattern = LEADING_FILLERS[i % LEADING_FILLERS.length];
    const match = pattern.exec(current);
    if (!match) continue;
    const candidate = match[0];
    if (!_isBarePleasantry(candidate)) continue;
    const remainder = current.slice(candidate.length);
    if (countWords(remainder) < minRemainingWords) continue;
    removedLeading.push(candidate.replace(/\s+$/, ''));
    current = remainder.replace(/^\s+/, '');
  }

  // Trailing: strip repeated offer-of-help closers (bounded). A single answer
  // commonly stacks two ("Hope this helps! Let me know if…").
  for (let i = 0; i < TRAILING_FILLERS.length * 3; i++) {
    const pattern = TRAILING_FILLERS[i % TRAILING_FILLERS.length];
    const match = pattern.exec(current);
    if (!match) continue;
    const candidate = match[0];
    const remainder = current.slice(0, match.index);
    if (countWords(remainder) < minRemainingWords) continue;
    removedTrailing.push(candidate.trim());
    current = remainder.replace(/\s+$/, '');
  }

  return { text: current, removedLeading, removedTrailing };
}

/**
 * Enforce a response contract against an answer, returning the possibly-stripped
 * text plus a truthful report.
 *
 * @param {string} text
 * @param {boolean|object} [contract]
 * @returns {{
 *   text: string,
 *   applied: boolean,
 *   answerOnly: boolean,
 *   removedLeading: string[],
 *   removedTrailing: string[],
 *   originalChars: number,
 *   finalChars: number,
 *   charsSaved: number,
 *   originalTokens: number,
 *   finalTokens: number,
 *   tokensSaved: number,
 *   isEstimate: boolean,
 *   wordCount: number,
 *   violations: string[]
 * }}
 */
export function enforceResponseContract(text, contract) {
  const normalized = normalizeContract(contract);
  const original = typeof text === 'string' ? text : '';
  const originalTokens = HonestTokenizer.countTokens(original);

  let finalText = original;
  let removedLeading = [];
  let removedTrailing = [];

  const shouldStrip = normalized.answerOnly || normalized.forbidPreamble;
  if (shouldStrip && original) {
    const stripped = stripPreambleAndTrailer(original, { minRemainingWords: normalized.minRemainingWords });
    finalText = stripped.text;
    removedLeading = stripped.removedLeading;
    removedTrailing = stripped.removedTrailing;
  }

  const violations = [];
  const wordCount = countWords(finalText);
  if (normalized.maxWords !== null && wordCount > normalized.maxWords) {
    violations.push(`MAX_WORDS_EXCEEDED: ${wordCount} > ${normalized.maxWords}`);
  }
  if (normalized.format === 'json') {
    try {
      JSON.parse(finalText);
    } catch {
      violations.push('FORMAT_JSON_INVALID');
    }
  }

  const finalTokens = HonestTokenizer.countTokens(finalText);

  return {
    text: finalText,
    applied: removedLeading.length > 0 || removedTrailing.length > 0,
    answerOnly: normalized.answerOnly || normalized.forbidPreamble,
    removedLeading,
    removedTrailing,
    originalChars: original.length,
    finalChars: finalText.length,
    charsSaved: Math.max(0, original.length - finalText.length),
    originalTokens,
    finalTokens,
    tokensSaved: Math.max(0, originalTokens - finalTokens),
    isEstimate: true,
    wordCount,
    violations
  };
}

/**
 * Apply a contract to a named field on a tool-arguments object in place.
 *
 * Returns `null` when no contract was supplied (so the durable layer stays
 * byte-identical to today's behaviour), otherwise a compact report suitable for
 * embedding in the tool result.
 *
 * @param {object} args
 * @param {string} fieldName
 * @returns {null|object}
 */
export function applyContractToField(args, fieldName) {
  if (!args || typeof args !== 'object' || args.contract === undefined || args.contract === null) {
    return null;
  }
  const value = args[fieldName];
  const report = enforceResponseContract(value, args.contract);
  if (typeof value === 'string') {
    args[fieldName] = report.text;
  }
  const applied = report.applied || report.violations.length > 0 || report.answerOnly;
  if (!applied) return null;
  return {
    answerOnly: report.answerOnly,
    applied: report.applied,
    removedLeading: report.removedLeading.length,
    removedTrailing: report.removedTrailing.length,
    charsSaved: report.charsSaved,
    tokensSaved: report.tokensSaved,
    isEstimate: report.isEstimate,
    wordCount: report.wordCount,
    violations: report.violations
  };
}
