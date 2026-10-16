import { ContentAddressedStore } from '../artifacts/content-addressed-store.js';
import { HonestTokenizer } from '../tokenizer/honest-tokenizer.js';

/**
 * Rolling Collaboration Summary Manager (Mission H.4)
 *
 * Prevents prompt bloat during multi-hop collaborations. Instead of forwarding
 * the full cumulative dialogue across N hops, the bridge maintains:
 * 1. A compact running summary of decisions, facts, and pending items.
 * 2. A content-addressed reference (ref:sha256:...) to the complete immutable turn history.
 *
 * Invariant: Zero information loss. Any agent can retrieve exact prior turns
 * by hash reference using bridge_slice_fetch or CAS lookup.
 */
export class RollingSummaryManager {
  constructor(options = {}) {
    this.cas = options.casStore || new ContentAddressedStore();
    this.tokenThreshold = options.tokenThreshold || 600; // Trigger summarization when history exceeds 600 tokens
    this.collaborations = new Map(); // collabId -> state
  }

  /**
   * Initialize or retrieve collaboration state.
   */
  getOrCreateCollab(collabId) {
    if (!this.collaborations.has(collabId)) {
      this.collaborations.set(collabId, {
        collabId,
        turns: [],
        decisions: [],
        keyFacts: [],
        summaryText: '',
        fullHistoryRef: null,
        updatedAt: Date.now()
      });
    }
    return this.collaborations.get(collabId);
  }

  /**
   * Append a turn to the collaboration and update rolling summary.
   * @param {string} collabId
   * @param {object} turn - { hop, fromAgent, toAgent, input, output, decision, facts }
   */
  appendTurn(collabId, turn) {
    const collab = this.getOrCreateCollab(collabId);
    collab.turns.push({
      ...turn,
      timestamp: Date.now()
    });

    if (turn.decision) {
      collab.decisions.push(turn.decision);
    }
    if (Array.isArray(turn.facts)) {
      collab.keyFacts.push(...turn.facts);
    } else if (turn.facts && typeof turn.facts === 'string') {
      collab.keyFacts.push(turn.facts);
    }

    // Persist complete raw history to CAS. Compact JSON keeps the CAS payload
    // (and the token measure below) free of indentation whitespace that would
    // otherwise inflate storage and prematurely trip the summarization threshold.
    const fullLogJson = JSON.stringify(collab.turns);
    const stored = this.cas.store(fullLogJson);
    collab.fullHistoryRef = stored.hash ? `ref:${stored.hash}` : (stored.ref || 'none');

    // Check if summary update is needed
    const rawTokens = HonestTokenizer.countTokens(fullLogJson);
    if (rawTokens > this.tokenThreshold) {
      collab.summaryText = this._generateRollingSummary(collab);
    } else {
      collab.summaryText = this._generateConciseLog(collab);
    }

    collab.updatedAt = Date.now();
    return collab;
  }

  /**
   * Get payload for the next hop: compact summary + history reference.
   */
  getNextHopPayload(collabId, newQuery = '') {
    const collab = this.getOrCreateCollab(collabId);
    const header = `[COLLABORATION-CONTEXT id=${collabId} hops=${collab.turns.length} ref=${collab.fullHistoryRef || 'none'}]`;
    const body = collab.summaryText || 'Initial turn.';
    const queryPart = newQuery ? `\n\nCurrent Instruction: ${newQuery}` : '';

    return `${header}\n${body}${queryPart}`;
  }

  /**
   * Retrieve full untruncated history by reference.
   */
  getFullHistory(collabId) {
    const collab = this.collaborations.get(collabId);
    if (!collab || !collab.fullHistoryRef) return [];
    const raw = this.cas.get(collab.fullHistoryRef);
    if (!raw) return collab.turns;
    try {
      const text = typeof raw === 'string' ? raw : (raw.content || '');
      return JSON.parse(text);
    } catch {
      return collab.turns;
    }
  }

  _generateRollingSummary(collab) {
    const lines = [];
    lines.push(`Summary of Progress (${collab.turns.length} hops completed):`);
    if (collab.decisions.length > 0) {
      lines.push('Decisions Settled:');
      collab.decisions.slice(-5).forEach(d => lines.push(`* ${d}`));
    }
    if (collab.keyFacts.length > 0) {
      lines.push('Key Findings & Facts:');
      collab.keyFacts.slice(-8).forEach(f => lines.push(`- ${f}`));
    }
    lines.push(`(Full turn log preserved in CAS reference ${collab.fullHistoryRef})`);
    return lines.join('\n');
  }

  _generateConciseLog(collab) {
    return collab.turns.map(t => `Hop ${t.hop} (${t.fromAgent} -> ${t.toAgent}): ${typeof t.output === 'string' ? t.output.slice(0, 150) : 'Done'}`).join('\n');
  }
}
