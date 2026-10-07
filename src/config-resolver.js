/**
 * Deterministic configuration value resolution.
 *
 * Configuration may be supplied directly (a literal) or indirectly via an
 * `env:NAME` reference that must be resolved from the process environment.
 *
 * Security requirements this enforces:
 *  - An `env:NAME` reference whose variable is missing or empty is a hard,
 *    deterministic error. It must never silently resolve to an empty secret,
 *    never silently disable an authentication boundary, and never fall back to
 *    an insecure default.
 *  - A reference to a non-existent variable name (`env:` or `env:   `) is also
 *    an error rather than an empty string.
 */

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ENV_PREFIX = 'env:';

/**
 * Retrieve a secret from macOS Keychain if running on darwin.
 * Returns the secret string, or null if unavailable or error.
 */
export function loadKeychainSecret(service = 'agent-bridge', account = 'control_plane_api_key') {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync('security', [
      'find-generic-password',
      '-s', service,
      '-a', account,
      '-w'
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
    return out ? out.trim() : null;
  } catch {
    return null;
  }
}

export function isEnvReference(raw) {
  return typeof raw === 'string' && raw.startsWith(ENV_PREFIX);
}

export function resolveConfigValue(raw, { name = null, required = false } = {}) {
  const label = name ? `'${name}'` : 'value';

  if (raw === undefined || raw === null) {
    if (required) {
      throw new Error(`Missing required configuration ${label}: no value supplied.`);
    }
    return null;
  }

  const str = String(raw);

  if (isEnvReference(str)) {
    const envName = str.slice(ENV_PREFIX.length).trim();
    if (!envName) {
      throw new Error(`Invalid configuration ${label}: 'env:' reference is missing a variable name.`);
    }

    const envValue = process.env[envName];
    if (envValue === undefined || envValue === '') {
      throw new Error(
        `Unresolved configuration ${label}: references env:${envName}, but environment variable '${envName}' is not set or is empty. ` +
        'Refusing to continue with an empty/missing secret.'
      );
    }
    return envValue;
  }

  if (str === '') {
    if (required) {
      throw new Error(`Missing required configuration ${label}: value must not be empty.`);
    }
    return null;
  }

  return str;
}

/**
 * Resolve an optional secret. Accepts either a literal value or an `env:NAME`
 * reference. Absent value resolves to null (feature disabled); a present but
 * unresolvable reference throws rather than degrading silently.
 */
export function resolveSecret(raw, { name = null } = {}) {
  return resolveConfigValue(raw, { name, required: false });
}

/**
 * Constant-time string comparison for secrets, to avoid leaking length/prefix
 * through timing. Returns false on any length or content mismatch.
 */
export function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}
