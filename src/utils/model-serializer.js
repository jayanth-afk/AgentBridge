/**
 * Model-Facing Result Serialization
 *
 * Tool results that leave the bridge are pasted straight into a host model's
 * prompt (Claude Desktop, ChatGPT, Antigravity IDE, headless CLI workers). The
 * host pays input tokens for every byte of that text, including the indentation
 * and newlines that pretty-printed JSON adds but that carry zero information.
 *
 * This module centralizes the serialization used on every model-facing path so
 * that results are emitted as **compact JSON** rather than pretty-printed JSON.
 *
 * Invariants (must never regress):
 *  1. Whitespace-only change. Field names, ordering, values, escaping, and types
 *     are byte-identical to the pretty-printed form once parsed; only the
 *     insignificant structural whitespace between tokens is removed.
 *  2. Strings are passed through verbatim (never re-quoted or re-escaped).
 *  3. `undefined` is normalized to `null` so the payload stays valid JSON.
 *
 * The reduction is deterministic and measurable; see
 * `scripts/bench/bench-model-serialization.mjs`.
 */

/**
 * Serialize an arbitrary tool result for consumption by a host model.
 *
 * @param {*} result - The value returned by a tool handler.
 * @returns {string} Compact JSON for non-string values; the string unchanged.
 */
export function serializeModelResult(result) {
  if (typeof result === 'string') return result;
  if (result === undefined) return 'null';
  return JSON.stringify(result);
}

/**
 * Serialize a tool execution failure for consumption by a host model.
 *
 * @param {string} toolName
 * @param {Error|string} err
 * @returns {string}
 */
export function serializeModelError(toolName, err) {
  const message = err && typeof err === 'object' && 'message' in err ? err.message : String(err);
  return `Error executing ${toolName}: ${message}`;
}
