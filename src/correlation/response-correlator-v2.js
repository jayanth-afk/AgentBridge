import crypto from 'node:crypto';

/**
 * Correlation Hierarchy Tiers
 * Progressively stronger evidence taxonomy.
 */
export const CorrelationTier = Object.freeze({
  TIER_1_AUTHENTICATED_TOOL_CALL: 1, // Authenticated bridge tool call bound to (attemptId, epoch, nonce)
  TIER_2_STRUCTURED_STREAM: 2,       // Structured JSONL/IPC message stream with thread/pid match
  TIER_3_NONCE_TOKEN_ECHO: 3,        // Cryptographic nonce echo found in model response
  TIER_4_SCOPED_UI_DELTA: 4,         // Verified UI element delta from pre-send snapshot
  TIER_5_HEURISTIC_TEXT: 5,          // Weak text heuristic / marker match
  TIER_6_NO_EVIDENCE: 6              // No verifiable correlation evidence
});

/**
 * Correlation Confidence Classification
 */
export const CorrelationConfidence = Object.freeze({
  VERIFIED: 'VERIFIED',       // Tier 1, 2, or 3 with valid cryptographic/protocol match
  UNVERIFIED: 'UNVERIFIED',   // Tier 4 or 5 (UI delta or heuristic)
  AMBIGUOUS: 'AMBIGUOUS',     // Multiple candidates or conflicting tokens
  NO_RESPONSE: 'NO_RESPONSE'  // Empty / timeout
});

export class CorrelatedResponse {
  constructor({
    requestId,
    attemptId,
    epoch,
    nonce,
    tier,
    confidence,
    rawResponse,
    cleanedResponse,
    evidence,
    isDuplicate = false,
    isReplayed = false,
    isExpired = false,
    agentMismatch = false
  }) {
    this.requestId = requestId;
    this.attemptId = attemptId;
    this.epoch = epoch;
    this.nonce = nonce;
    this.tier = tier;
    this.confidence = confidence;
    this.rawResponse = rawResponse;
    this.cleanedResponse = cleanedResponse;
    this.evidence = evidence;
    this.isDuplicate = isDuplicate;
    this.isReplayed = isReplayed;
    this.isExpired = isExpired;
    this.agentMismatch = agentMismatch;
    this.timestamp = new Date().toISOString();
  }

  /**
   * Hard Invariant 2 & 10:
   * An ambiguous response, replayed response, or no-evidence response must NEVER satisfy terminal success.
   */
  isAcceptableForSuccess() {
    return this.confidence === CorrelationConfidence.VERIFIED && !this.isReplayed && !this.isExpired && !this.agentMismatch;
  }
}

export class ResponseCorrelatorV2 {
  constructor(options = {}) {
    this.options = options;
    this.activeNonces = new Map();
    this.consumedNonces = new Map();
    this.nonceTtlMs = options.nonceTtlMs || (10 * 60 * 1000);
  }

  /**
   * Generates a unique, non-guessable correlation nonce bound to (request, attempt, epoch, route)
   */
  generateNonce(requestId, attemptId, epoch, routeId) {
    const raw = `${requestId}::${attemptId}::${epoch}::${routeId}::${crypto.randomBytes(12).toString('hex')}`;
    const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
    return `ABN-${digest}`;
  }

  /**
   * Formats prompt with correlation marker for routes supporting text echoes
   */
  embedNonceInPrompt(prompt, nonce) {
    return `${prompt}\n\n<!-- [AgentBridge Correlation: ${nonce}] -->`;
  }

  /**
   * Extracts nonce token if echoed in raw model output
   */
  extractNonce(text) {
    if (!text || typeof text !== 'string') return null;
    const match = text.match(/ABN-[a-f0-9]{16}/i);
    return match ? match[0] : null;
  }

  /**
   * Cleans internal correlation markers out of user-facing response text
   */
  cleanResponseText(text) {
    if (!text || typeof text !== 'string') return '';
    return text
      .replace(/<!--\s*\[AgentBridge Correlation:\s*ABN-[a-f0-9]{16}\]\s*-->/gi, '')
      .replace(/\[AgentBridge Correlation:\s*ABN-[a-f0-9]{16}\]/gi, '')
      .replace(/ABN-[a-f0-9]{16}/gi, '')
      .replace(/\[AB:[a-zA-Z0-9_-]+\]\s*/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  cleanResponse(text) {
    return this.cleanResponseText(text);
  }

  tagMessage(text, requestId, nonce = null, metadata = {}) {
    const randNonce = nonce || `ABN-${crypto.randomBytes(8).toString('hex')}`;
    if (requestId) {
      this.activeNonces.set(requestId, {
        nonce: randNonce,
        createdAt: Date.now(),
        attemptId: metadata.attemptId || null,
        epoch: metadata.epoch || null,
        agentId: metadata.agentId || null,
        routeId: metadata.routeId || null
      });
    }
    return this.embedNonceInPrompt(text, randNonce);
  }

  correlateTurn({ rawResponse, expectedRequestId, nonce = null, agentId = null, attemptId = null, epoch = null }) {
    if (!rawResponse) {
      return { correlated: false, error: 'EMPTY_RESPONSE', confidence: CorrelationConfidence.NO_RESPONSE };
    }
    const activeEntry = expectedRequestId ? this.activeNonces.get(expectedRequestId) : null;
    const resolvedNonce = nonce || (typeof activeEntry === 'object' && activeEntry !== null ? activeEntry.nonce : activeEntry);
    const resolvedAttemptId = attemptId || (typeof activeEntry === 'object' && activeEntry !== null ? activeEntry.attemptId : null);
    const resolvedEpoch = epoch !== null && epoch !== undefined ? epoch : (typeof activeEntry === 'object' && activeEntry !== null ? activeEntry.epoch : null);

    const result = this.correlate({
      requestId: expectedRequestId,
      attemptId: resolvedAttemptId,
      epoch: resolvedEpoch,
      agentId,
      expectedNonce: resolvedNonce,
      rawResponse
    });
    return {
      correlated: result.isAcceptableForSuccess(),
      confidence: result.confidence,
      tier: result.tier,
      cleanedText: result.cleanedResponse || this.cleanResponseText(rawResponse),
      rawResponse,
      evidence: result.evidence,
      isDuplicate: result.isDuplicate,
      isReplayed: result.isReplayed,
      isExpired: result.isExpired
    };
  }

  /**
   * Evaluate correlation evidence according to the 6-tier hierarchy
   */
  correlate({
    requestId,
    attemptId,
    epoch,
    expectedNonce = null,
    rawResponse = null,
    isAuthenticatedToolCall = false,
    isStructuredStream = false,
    uiDeltaSnapshot = null,
    agentId = null
  }) {
    if (rawResponse === null || rawResponse === undefined) {
      return new CorrelatedResponse({
        requestId,
        attemptId,
        epoch,
        nonce: expectedNonce,
        tier: CorrelationTier.TIER_6_NO_EVIDENCE,
        confidence: CorrelationConfidence.NO_RESPONSE,
        rawResponse: null,
        cleanedResponse: null,
        evidence: 'No response payload received'
      });
    }

    const rawStr = typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse);

    // 1. Tier 1: Authenticated Completion Call bound to (attempt_id, epoch, nonce)
    if (isAuthenticatedToolCall) {
      return new CorrelatedResponse({
        requestId,
        attemptId,
        epoch,
        nonce: expectedNonce,
        tier: CorrelationTier.TIER_1_AUTHENTICATED_TOOL_CALL,
        confidence: CorrelationConfidence.VERIFIED,
        rawResponse: rawStr,
        cleanedResponse: this.cleanResponseText(rawStr),
        evidence: 'Authenticated bridge tool call matches active attempt and epoch'
      });
    }

    // 2. Tier 2: Structured JSONL / Process Stream with PID and thread match
    if (isStructuredStream) {
      return new CorrelatedResponse({
        requestId,
        attemptId,
        epoch,
        nonce: expectedNonce,
        tier: CorrelationTier.TIER_2_STRUCTURED_STREAM,
        confidence: CorrelationConfidence.VERIFIED,
        rawResponse: rawStr,
        cleanedResponse: this.cleanResponseText(rawStr),
        evidence: 'Direct structured JSONL/IPC event stream from local engine process'
      });
    }

    // 3. Tier 3: Cryptographic Nonce Echo
    if (expectedNonce) {
      // Replay detection: check if nonce was already consumed
      if (this.consumedNonces.has(expectedNonce)) {
        const record = this.consumedNonces.get(expectedNonce);
        const respHash = crypto.createHash('sha256').update(rawStr).digest('hex');
        if (record.responseHash === respHash) {
          // Idempotent duplicate response delivered
          return new CorrelatedResponse({
            requestId,
            attemptId: attemptId || record.attemptId,
            epoch: epoch || record.epoch,
            nonce: expectedNonce,
            tier: CorrelationTier.TIER_3_NONCE_TOKEN_ECHO,
            confidence: CorrelationConfidence.VERIFIED,
            rawResponse: rawStr,
            cleanedResponse: this.cleanResponseText(rawStr),
            evidence: `Idempotent duplicate response delivered for already-consumed nonce ${expectedNonce}`,
            isDuplicate: true
          });
        }
        return new CorrelatedResponse({
          requestId,
          attemptId,
          epoch,
          nonce: expectedNonce,
          tier: CorrelationTier.TIER_6_NO_EVIDENCE,
          confidence: CorrelationConfidence.AMBIGUOUS,
          rawResponse: rawStr,
          cleanedResponse: null,
          evidence: `REPLAY_REJECTED: Nonce ${expectedNonce} was already consumed`,
          isReplayed: true
        });
      }

      // Check active entry for expiry or agent mismatch
      const activeEntry = requestId ? this.activeNonces.get(requestId) : null;
      if (activeEntry && typeof activeEntry === 'object') {
        if (activeEntry.createdAt && (Date.now() - activeEntry.createdAt > this.nonceTtlMs)) {
          return new CorrelatedResponse({
            requestId,
            attemptId,
            epoch,
            nonce: expectedNonce,
            tier: CorrelationTier.TIER_6_NO_EVIDENCE,
            confidence: CorrelationConfidence.NO_RESPONSE,
            rawResponse: rawStr,
            cleanedResponse: null,
            evidence: `EXPIRED_REJECTED: Nonce ${expectedNonce} has expired`,
            isExpired: true
          });
        }
        if (agentId && activeEntry.agentId && agentId !== activeEntry.agentId) {
          return new CorrelatedResponse({
            requestId,
            attemptId,
            epoch,
            nonce: expectedNonce,
            tier: CorrelationTier.TIER_6_NO_EVIDENCE,
            confidence: CorrelationConfidence.NO_RESPONSE,
            rawResponse: rawStr,
            cleanedResponse: null,
            evidence: `AGENT_MISMATCH_REJECTED: Agent '${agentId}' does not match expected '${activeEntry.agentId}'`,
            agentMismatch: true
          });
        }
      }

      const foundNonce = this.extractNonce(rawStr);
      const markerMatch = rawStr.match(/\[AB:([a-zA-Z0-9_-]+)\]/i);
      const foundMarkerId = markerMatch ? markerMatch[1] : null;
      const markerMatches = Boolean(requestId && foundMarkerId && foundMarkerId.toLowerCase() === requestId.toLowerCase());

      if ((foundNonce && foundNonce.toLowerCase() === expectedNonce.toLowerCase()) || markerMatches) {
        // Atomic single-use consumption
        const respHash = crypto.createHash('sha256').update(rawStr).digest('hex');
        this.consumedNonces.set(expectedNonce, {
          consumedAt: Date.now(),
          requestId,
          attemptId,
          epoch,
          responseHash: respHash
        });
        if (requestId) {
          this.activeNonces.delete(requestId);
        }

        return new CorrelatedResponse({
          requestId,
          attemptId,
          epoch,
          nonce: expectedNonce,
          tier: CorrelationTier.TIER_3_NONCE_TOKEN_ECHO,
          confidence: CorrelationConfidence.VERIFIED,
          rawResponse: rawStr,
          cleanedResponse: this.cleanResponseText(rawStr),
          evidence: markerMatches
            ? `Model response echoed exact request marker [AB:${requestId}]`
            : `Model response echoed exact cryptographic nonce ${expectedNonce}`
        });
      }
    }

    // 4. Tier 4: Scoped UI Delta (pre-send snapshot vs post-send snapshot)
    if (uiDeltaSnapshot && uiDeltaSnapshot.hasNewMessage && !uiDeltaSnapshot.isAmbiguous) {
      return new CorrelatedResponse({
        requestId,
        attemptId,
        epoch,
        nonce: expectedNonce,
        tier: CorrelationTier.TIER_4_SCOPED_UI_DELTA,
        confidence: CorrelationConfidence.UNVERIFIED,
        rawResponse: rawStr,
        cleanedResponse: this.cleanResponseText(rawStr),
        evidence: 'Tightly scoped UI message count delta in target thread (Unverified UI channel)'
      });
    }

    if (uiDeltaSnapshot?.isAmbiguous) {
      return new CorrelatedResponse({
        requestId,
        attemptId,
        epoch,
        nonce: expectedNonce,
        tier: CorrelationTier.TIER_4_SCOPED_UI_DELTA,
        confidence: CorrelationConfidence.AMBIGUOUS,
        rawResponse: rawStr,
        cleanedResponse: null,
        evidence: 'Ambiguous UI observation: multiple messages or foreground window changed during turn'
      });
    }

    // 5. Tier 5: Heuristic Text
    if (rawStr.length > 0) {
      return new CorrelatedResponse({
        requestId,
        attemptId,
        epoch,
        nonce: expectedNonce,
        tier: CorrelationTier.TIER_5_HEURISTIC_TEXT,
        confidence: CorrelationConfidence.UNVERIFIED,
        rawResponse: rawStr,
        cleanedResponse: this.cleanResponseText(rawStr),
        evidence: 'Unverified heuristic text observation without nonce echo'
      });
    }

    // 6. Tier 6: No evidence
    return new CorrelatedResponse({
      requestId,
      attemptId,
      epoch,
      nonce: expectedNonce,
      tier: CorrelationTier.TIER_6_NO_EVIDENCE,
      confidence: CorrelationConfidence.NO_RESPONSE,
      rawResponse: rawStr,
      cleanedResponse: null,
      evidence: 'No correlation evidence found'
    });
  }
}
