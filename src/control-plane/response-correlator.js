/**
 * ResponseCorrelator:
 * Embeds compact machine-readable correlation markers into outbound payloads,
 * identifies correlated response turns, and cleanly strips markers from final outputs
 * to avoid polluting the user's conversational experience.
 */
export class ResponseCorrelator {
  constructor(options = {}) {
    this.markerPrefix = options.markerPrefix || 'AB';
  }

  /**
   * Format message with compact machine marker
   * Example: "[AB:req_abc123]\nAnalyze this file."
   */
  tagMessage(text, requestId) {
    if (!requestId) return text;
    const marker = `[${this.markerPrefix}:${requestId}]`;
    if (text.startsWith(marker)) return text;
    return `${marker}\n${text}`;
  }

  /**
   * Extract correlation marker from a string if present
   */
  extractMarker(text) {
    if (!text || typeof text !== 'string') return null;
    const regex = new RegExp(`\\[${this.markerPrefix}:([a-zA-Z0-9_-]+)\\]`);
    const match = text.match(regex);
    return match ? match[1] : null;
  }

  /**
   * Check if text contains the specific requestId marker
   */
  hasMarker(text, requestId) {
    if (!text || !requestId) return false;
    const escapedPrefix = this.markerPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedId = requestId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const exactRegex = new RegExp(`\\[${escapedPrefix}:${escapedId}\\]`, 'i');
    return exactRegex.test(text);
  }

  /**
   * Strip marker cleanly from output text
   */
  cleanResponse(text) {
    if (!text || typeof text !== 'string') return text;
    const regex = new RegExp(`\\[${this.markerPrefix}:[a-zA-Z0-9_-]+\\]\\s*`, 'g');
    return text.replace(regex, '').trim();
  }

  /**
   * Correlate incoming assistant message with expected request
   */
  correlateTurn({ rawResponse, expectedRequestId, conversationHistory = [] }) {
    if (!rawResponse) {
      return { correlated: false, error: 'EMPTY_RESPONSE' };
    }

    const foundMarker = this.extractMarker(rawResponse);
    const hasExpected = expectedRequestId ? this.hasMarker(rawResponse, expectedRequestId) : false;

    // Cleaned output text
    const cleaned = this.cleanResponse(rawResponse);

    // If expectedRequestId is specified, the exact marker is strictly required.
    // An ordinary text mention of the request ID does NOT correlate.
    const correlated = expectedRequestId ? hasExpected : (!foundMarker && Boolean(cleaned));

    return {
      correlated,
      foundMarker,
      expectedRequestId,
      cleanedText: cleaned,
      rawLength: rawResponse.length,
      cleanedLength: cleaned.length
    };
  }
}
