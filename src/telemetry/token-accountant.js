/**
 * TokenAccountant
 *
 * Implements granular, honest token-accounting for multi-agent delegation.
 * Distinguishes:
 *   A. Delegation overhead (request framing & instruction)
 *   B. Responding agent reasoning & answer generation
 *   C. Transport overhead (deterministic bridge = 0 tokens)
 *   D. Receiving agent additional reasoning (critique/inspection)
 *   E. Receiving agent answer regeneration (0 in Direct Delivery mode!)
 *   F. Final user-visible delivery
 *
 * Adheres strictly to the honesty invariant:
 * - Uses real provider-reported tokens when available (e.g. usage.prompt_tokens, usage.completion_tokens)
 * - Flags heuristic calculations explicitly as 'estimated'
 * - Never invents usage data for providers that do not expose it
 */
export class TokenAccountant {
  constructor(options = {}) {
    this.records = new Map(); // requestId -> tokenMetrics
    this.options = options;
  }

  /**
   * Approximate tokens from character length (1 token ~= 4 characters in English).
   * Used strictly for estimates when provider telemetry is absent.
   */
  static estimateTokens(text) {
    if (typeof text !== 'string' || text.length === 0) return 0;
    return Math.max(1, Math.ceil(text.length / 4));
  }

  /**
   * Record token accounting for a delegated turn.
   */
  recordTurn({
    requestId,
    taskId = null,
    collaborationId = null,
    responseMode = 'direct',
    requestingAgent = 'chatgpt',
    respondingAgent = 'gemini',
    promptText = '',
    responseText = '',
    providerUsage = null,
    receivingPostProcessing = null // null in direct mode!
  }) {
    if (!requestId) throw new Error('requestId is required for token accounting');

    const hasProviderUsage = Boolean(providerUsage && (providerUsage.prompt_tokens || providerUsage.input_tokens));
    const respondingInputTokens = hasProviderUsage
      ? (providerUsage.prompt_tokens || providerUsage.input_tokens || 0)
      : TokenAccountant.estimateTokens(promptText);
    const respondingOutputTokens = hasProviderUsage
      ? (providerUsage.completion_tokens || providerUsage.output_tokens || 0)
      : TokenAccountant.estimateTokens(responseText);

    // Byte accounting is a transportation metric and is NEVER conflated with
    // model token consumption (a byte count is not a context-window cost).
    const promptBytes = Buffer.byteLength(typeof promptText === 'string' ? promptText : '', 'utf8');
    const responseBytes = Buffer.byteLength(typeof responseText === 'string' ? responseText : '', 'utf8');

    // Category A: Delegation Overhead
    const categoryA_delegationOverhead = TokenAccountant.estimateTokens(promptText);

    // Category B: Responding Agent Reasoning & Generation
    const categoryB_respondingAgentTokens = respondingOutputTokens;

    // Category C: Transport Overhead (Deterministic infrastructure)
    const categoryC_transportOverhead = 0; // Deterministic bridge uses 0 model tokens!

    // Category D: Receiving Agent Additional Reasoning (only in Assist mode)
    const categoryD_receivingReasoning = (responseMode === 'assist' && receivingPostProcessing?.reasoningTokens)
      ? receivingPostProcessing.reasoningTokens
      : 0;

    // Category E: Receiving Agent Answer Regeneration
    // In DIRECT MODE, this is strictly ZERO (no model call permitted to regenerate)
    const categoryE_receivingRegeneration = (responseMode === 'direct')
      ? 0
      : (receivingPostProcessing?.regenerationTokens || 0);

    // Category F: Final User-Visible Delivery
    const categoryF_finalDelivery = (responseMode === 'direct')
      ? respondingOutputTokens
      : (receivingPostProcessing?.finalTokens || respondingOutputTokens);

    // Estimated tokens saved by direct delivery:
    // If receiving agent had to rephrase/regenerate the response, it would consume:
    // 1. Input tokens to read the responding agent's output
    // 2. Output tokens to reproduce/summarize the response
    const potentialRegenerationCost = respondingOutputTokens + Math.ceil(respondingOutputTokens * 0.9);
    const tokensSavedByDirectDelivery = (responseMode === 'direct')
      ? potentialRegenerationCost
      : 0;

    const metrics = {
      requestId,
      taskId,
      collaborationId,
      responseMode,
      requestingAgent,
      respondingAgent,
      tokens: {
        // Every token figure carries an explicit provenance flag. When a provider
        // did not report usage, the number is a heuristic ESTIMATE (length/4) and
        // MUST NOT be presented as measured provider usage.
        requestingAgent: {
          inputTokens: categoryA_delegationOverhead,
          outputTokens: 0,
          isReportedByProvider: false,
          isEstimated: true
        },
        respondingAgent: {
          inputTokens: respondingInputTokens,
          outputTokens: respondingOutputTokens,
          totalTokens: respondingInputTokens + respondingOutputTokens,
          isReportedByProvider: hasProviderUsage,
          isEstimated: !hasProviderUsage
        },
        postProcessing: {
          reasoningTokens: categoryD_receivingReasoning,
          regenerationTokens: categoryE_receivingRegeneration,
          isReportedByProvider: Boolean(receivingPostProcessing?.isReportedByProvider),
          isEstimated: true
        }
      },
      // Byte payload sizes are tracked separately from token counts. Reductions in
      // transported bytes do NOT imply equivalent reductions in model token usage.
      byteMetrics: {
        promptBytes,
        responseBytes,
        transportOverheadBytes: 0
      },
      categories: {
        A_delegationOverhead: categoryA_delegationOverhead,
        B_respondingAgentGeneration: categoryB_respondingAgentTokens,
        C_transportOverhead: categoryC_transportOverhead,
        D_receivingAgentReasoning: categoryD_receivingReasoning,
        E_receivingAgentRegeneration: categoryE_receivingRegeneration,
        F_finalDelivery: categoryF_finalDelivery
      },
      savings: {
        tokensSavedByDirectDelivery,
        isEstimatedSavings: !hasProviderUsage || responseMode === 'direct',
        directDeliveryBypassedModelCall: responseMode === 'direct'
      },
      recordedAt: new Date().toISOString()
    };

    this.records.set(requestId, metrics);
    return metrics;
  }

  getMetrics(requestId) {
    return this.records.get(requestId) || null;
  }

  getAllMetrics() {
    return Array.from(this.records.values());
  }

  getSummary() {
    let totalDirect = 0;
    let totalAssist = 0;
    let totalStructured = 0;
    let totalTokensSaved = 0;
    let totalRegenerationTokensPrevented = 0;

    for (const m of this.records.values()) {
      if (m.responseMode === 'direct') totalDirect++;
      else if (m.responseMode === 'assist') totalAssist++;
      else if (m.responseMode === 'structured') totalStructured++;

      totalTokensSaved += m.savings.tokensSavedByDirectDelivery || 0;
      if (m.responseMode === 'direct') {
        totalRegenerationTokensPrevented += m.categories.B_respondingAgentGeneration;
      }
    }

    return {
      totalTurnsRecorded: this.records.size,
      breakdownByMode: {
        direct: totalDirect,
        assist: totalAssist,
        structured: totalStructured
      },
      totalTokensSaved,
      totalRegenerationTokensPrevented,
      transportOverheadTokens: 0
    };
  }
}
