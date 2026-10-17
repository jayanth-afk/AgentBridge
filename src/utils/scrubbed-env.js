/**
 * Centralized, allowlisted environment scrub for all spawned child processes.
 *
 * Prevents process.env leakage (API keys, bridge tokens, secrets, credentials)
 * to any spawned tool, adapter, CLI or helper process.
 */

export const ALLOWED_ENV_WHITELIST = Object.freeze([
  'PATH',
  'HOME',
  'LANG',
  'TERM',
  'TMPDIR',
  'NODE_PATH'
]);

export const FORBIDDEN_SECRET_ENV_KEYS = Object.freeze([
  'CONTROL_PLANE_API_KEY',
  'CONTROL_PLANE_API_KEY_CONFIG',
  'AGENT_BRIDGE_API_KEY',
  'AGENT_BRIDGE_DASHBOARD_TOKEN',
  'AGENT_BRIDGE_API_SECRET',
  'BRIDGE_API_KEY'
]);

export function getScrubbedEnv(extraEnv = {}) {
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin',
    HOME: process.env.HOME || '/Users/jayanthpranaykonada',
    LANG: process.env.LANG || 'en_US.UTF-8',
    TMPDIR: process.env.TMPDIR || '/tmp',
    TERM: process.env.TERM || 'xterm-256color'
  };

  // Allowlist only explicit keys and LC_* variables from parent process.env
  for (const [key, value] of Object.entries(process.env)) {
    if (FORBIDDEN_SECRET_ENV_KEYS.includes(key)) continue;
    if (ALLOWED_ENV_WHITELIST.includes(key) || key.startsWith('LC_')) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
  }

  // Merge extra manifest-declared variables, strictly scrubbing secret keys
  if (extraEnv && typeof extraEnv === 'object') {
    for (const [k, v] of Object.entries(extraEnv)) {
      if (FORBIDDEN_SECRET_ENV_KEYS.includes(k)) continue;
      if (v !== undefined && v !== null) {
        env[k] = String(v);
      }
    }
  }

  return env;
}

