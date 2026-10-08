/**
 * Verification Token Safety Layer
 *
 * SPECIFICATION & INVARIANTS:
 * 1. Verification tokens are NON-SENSITIVE test fixtures intended specifically for
 *    Agent Bridge interoperability testing and inter-agent handshake verification.
 * 2. They are NEVER passwords, API keys, authentication credentials, private keys,
 *    or personal secrets.
 * 3. They CANNOT be used to authenticate callers to the HTTP Control Plane or
 *    AgentIdentityManager.
 * 4. Agent-to-agent requests are allowed to ask another registered agent for its
 *    registered verification token, traveling through the normal request/task/outbox pipeline.
 * 5. Requests attempting to extract actual secrets, credentials, passwords, API keys,
 *    private keys, DOBs, or sensitive personal data are STRICTLY BLOCKED.
 */

export const VERIFICATION_TOKEN_VALUE = 'verification_token';

export const SECURITY_DENIAL_MESSAGE =
  'ACCESS_DENIED_SENSITIVE_CREDENTIAL: Requests for passwords, API keys, credentials, private keys, DOBs, or personal secrets are strictly blocked by Agent Bridge security policy.';

/**
 * Explicit registry of non-sensitive verification tokens for all registered agents.
 * Every token is explicitly registered as a non-secret test value.
 */
export const REGISTERED_VERIFICATION_TOKENS = Object.freeze({
  'chatgpt-desktop': VERIFICATION_TOKEN_VALUE,
  'claude-desktop': VERIFICATION_TOKEN_VALUE,
  'antigravity-ide': VERIFICATION_TOKEN_VALUE,
  'gemini': VERIFICATION_TOKEN_VALUE,
  'freebuff': VERIFICATION_TOKEN_VALUE,
  'system': VERIFICATION_TOKEN_VALUE,
  'zia': VERIFICATION_TOKEN_VALUE
});

/**
 * Patterns matching sensitive credential or secret extraction attempts.
 * Any request matching these patterns is strictly denied at the boundary.
 */
const SENSITIVE_CREDENTIAL_PATTERNS = [
  /\bapi[_\s-]?keys?\b/i,
  /\bpass(?:words?|phrases?)\b/i,
  /\b(?:private|ssh|signing)[_\s-]?keys?\b/i,
  /\bcredentials?\b/i,
  /\b(?:auth|authentication)[_\s-]*(?:tokens?|keys?|credentials?|headers?)\b/i,
  /\b(?:bearer|oauth|access|refresh|session|jwt)[_\s-]?tokens?\b/i,
  /\bpersonal[_\s-]?secrets?\b/i,
  /\b(?:date[_\s-]?of[_\s-]?birth|dob)\b/i,
  /\b(?:social[_\s-]?security(?:[_\s-]?number)?|ssn)\b/i,
  /\bcredit[_\s-]?cards?\b/i,
  /\b(?:process\.env|\.env(?:file)?)\b/i,
  /\bkeychains?\b/i,
  // Match "secret" / "secrets" unless explicitly preceded by "non-" (e.g. "non-secret")
  /(?<!non[-_\s])\bsecrets?\b/i
];

/**
 * Check if text asks for sensitive credentials or secrets.
 *
 * @param {string} text
 * @returns {{ sensitive: boolean, reason?: string }}
 */
export function isSensitiveCredentialRequest(text) {
  if (!text || typeof text !== 'string') {
    return { sensitive: false };
  }
  const trimmed = text.trim();
  for (const pattern of SENSITIVE_CREDENTIAL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        sensitive: true,
        reason: SECURITY_DENIAL_MESSAGE
      };
    }
  }
  return { sensitive: false };
}

/**
 * Check if text is a legitimate query for an agent's registered verification token.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isVerificationTokenRequest(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();

  // Sensitivity check takes absolute precedence: any mention of sensitive credentials blocks the query
  if (isSensitiveCredentialRequest(trimmed).sensitive) {
    return false;
  }

  // Canonical pattern: "Return your registered Agent Bridge verification token." and natural variations
  const matchesInquiry =
    /(?:return|get|show|provide|what\s+is|give\s+me|send|verify)\s+(?:your\s+)?(?:registered\s+)?(?:agent\s+bridge\s+)?verification\s+token/i.test(trimmed) ||
    /^(?:registered\s+)?(?:agent\s+bridge\s+)?verification\s+token[.?!\s]*$/i.test(trimmed);

  return matchesInquiry;
}

/**
 * Get the registered non-sensitive verification token for an agent.
 *
 * @param {string} agentId
 * @returns {string|null}
 */
export function getRegisteredVerificationToken(agentId) {
  if (!agentId || typeof agentId !== 'string') return null;
  const normalized = agentId.trim().toLowerCase();
  return REGISTERED_VERIFICATION_TOKENS[normalized] || null;
}

/**
 * Test whether a token string is a registered verification token.
 *
 * @param {string} token
 * @returns {boolean}
 */
export function isRegisteredVerificationToken(token) {
  if (!token || typeof token !== 'string') return false;
  return Object.values(REGISTERED_VERIFICATION_TOKENS).includes(token);
}
