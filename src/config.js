import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSecret, loadKeychainSecret } from './config-resolver.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BRIDGE_ROOT = path.resolve(__dirname, '..');

export const CONFIG = {
  BRIDGE_ROOT,
  DATA_DIR: path.join(BRIDGE_ROOT, 'data'),
  DB_PATH: path.join(BRIDGE_ROOT, 'data', 'bridge.sqlite'),
  TEST_WORKSPACE: path.join(BRIDGE_ROOT, 'test-workspace'),
  ZIA_ROOT: '/Users/jayanthpranaykonada/Zia',
  
  // Agent Bridge is explicitly authorized by the owner to mutate the
  // entire user home directory. macOS/TCC/UNIX permissions still apply.
  ZIA_WRITE_LOCKED: false,

  // All paths under the user's home directory are in scope.
  ALLOWED_ROOTS: [
    path.join(BRIDGE_ROOT, 'test-workspace'),
    '/Users/jayanthpranaykonada'
  ],

  // No Agent-Bridge-level filename denylist for mutation. OS-level protections remain authoritative.
  PROTECTED_FILES: [],

  // Credential and secret locations that no agent may read or write, even inside
  // ALLOWED_ROOTS. Each pattern is tested against both the lexical path and the
  // symlink-resolved path, and (see COMMAND_ARG_PATH_CHECK) against path-like
  // command arguments. Deliberately NOT listed: app config dirs agents may need to
  // edit (for example Claude's claude_desktop_config.json).
  FORBIDDEN_PATH_PATTERNS: [
    /\/\.ssh(\/|$)/,
    /\/\.gnupg(\/|$)/,
    /\/\.aws(\/|$)/,
    /\/\.config\/gcloud(\/|$)/,
    /\/\.codex\/auth\.json$/,
    /\/\.gemini\/oauth_creds\.json$/,
    /\/\.docker\/config\.json$/,
    /\/\.netrc$/,
    /\/\.npmrc$/,
    /\/\.env(\.(local|production|development))?$/,
    /\/id_(rsa|dsa|ecdsa|ed25519)$/,
    /\/Library\/Keychains(\/|$)/,
    /\/Library\/Cookies(\/|$)/,
    /\/Library\/Application Support\/(Google\/Chrome|BraveSoftware|Arc|Dia|Comet|Firefox)(\/|$)/
  ],

  // When true, path-like arguments of whitelisted commands are checked against the
  // same path policy as direct file operations (roots + denylist). Without this,
  // `cat ~/.ssh/id_ed25519` bypasses the policy entirely because only the first
  // token and the cwd were validated. Interpreters (python3, node, swift, npm) can
  // still open files from inside their own arguments; see the recipe work.
  COMMAND_ARG_PATH_CHECK: true,

  // Liveness beacon returned by `bridge ping` / the bridge_ping tool so callers can
  // confirm they reached a real bridge. Override per-deployment via env; never commit
  // a site-specific literal here.
  RESPONSE_TOKEN: process.env.AGENT_BRIDGE_RESPONSE_TOKEN || 'AGENT_BRIDGE_ALIVE',

  // Human-readable environment label. Derived from the running host rather than
  // hardcoded, and does not include the hostname or username.
  ENVIRONMENT_LABEL:
    process.env.AGENT_BRIDGE_ENVIRONMENT || `${os.platform()} ${os.arch()}`,

  // Control-plane authentication boundary.
  //
  // `api_key` may be a literal secret or an `env:CONTROL_PLANE_API_KEY`
  // reference. When the reference is used but the variable is missing/empty,
  // resolution throws at startup instead of silently disabling authentication.
  // `require_api_key` forces the HTTP control plane to reject unauthenticated
  // requests; it must have a usable key or startup fails.
  CONTROL_PLANE: (() => {
    // `control_plane.api_key` accepts a literal value or an `env:NAME`
    // indirection. A present but unresolvable reference throws here at startup.
    const isPlaceholder = (k) => typeof k === 'string' && (/^YOUR_API_KEY/i.test(k.trim()) || k.trim() === '<api-key>');
    let rawKey = process.env.CONTROL_PLANE_API_KEY_CONFIG ?? process.env.CONTROL_PLANE_API_KEY;
    if (isPlaceholder(rawKey)) rawKey = null;
    if (!rawKey && process.platform === 'darwin') {
      const keychainSecret = loadKeychainSecret('agent-bridge', 'control_plane_api_key');
      if (keychainSecret) rawKey = keychainSecret;
    }
    const requireFlag = process.env.CONTROL_PLANE_REQUIRE_API_KEY;
    return {
      API_KEY: resolveSecret(rawKey, { name: 'control_plane.api_key' }),
      REQUIRE_API_KEY: requireFlag === '1' || requireFlag === 'true'
    };
  })(),

  // Legacy compatibility: allow a bound connection to *act as* a different
  // known identity. Off by default because it is an impersonation vector.
  // Operators that truly need it can set AGENT_BRIDGE_ALLOW_IDENTITY_COMPATIBILITY=1.
  ALLOW_IDENTITY_COMPATIBILITY:
    process.env.AGENT_BRIDGE_ALLOW_IDENTITY_COMPATIBILITY === '1' ||
    process.env.AGENT_BRIDGE_ALLOW_IDENTITY_COMPATIBILITY === 'true',

  // Known agent identities
  AGENT_IDENTITIES: [
    'chatgpt-desktop',
    'claude-desktop',
    'zia',
    'antigravity-ide',
    'freebuff',
    'system'
  ],

  // Whitelisted command executables for safe execution
  SAFE_COMMANDS: [
    'swift',
    'git',
    'node',
    'npm',
    'python3',
    'ls',
    'cat',
    'grep',
    'find',
    'echo',
    'pwd'
  ],

  // Blacklisted dangerous patterns in command line
  DANGEROUS_COMMAND_PATTERNS: [
    /rm\s+-rf/i,
    /sudo\s+/i,
    /chmod\s+/i,
    /chown\s+/i,
    /curl\s+/i,
    /wget\s+/i,
    /mkfs/i,
    /dd\s+if=/i,
    /:>{1,2}/,
    /\|\s*bash/i,
    /\|\s*sh/i
  ],

  // Autonomous Git settings
  GIT_PROTECTED_BRANCHES: ['main', 'master', 'production', 'release'],
  ALLOW_AUTONOMOUS_PROTECTED_PUSH: false,

  // Sideways / Desktop UI Automation & Control Plane config
  DESKTOP_AUTOMATION: {
    enabled: false, // Explicit opt-in required
    preferredRoute: 'auto', // 'auto' | 'mcp' | 'accessibility' | 'cdp' | 'browser' | 'notification'
    preferredTransport: 'mcp', // legacy compatibility
    requireUnambiguousTarget: true,
    preventDuplicates: true,
    focusOnSend: false,
    accessibility: {
      enabled: true,
      useNativeSwiftHelper: true,
      allowHiddenWindowActivation: true,
      activationTimeoutMs: 2500
    },
    cdp: {
      enabled: false,
      port: 9222,
      allowedHosts: ['127.0.0.1', 'localhost']
    },
    browser: {
      enabled: false,
      headless: false
    },
    notifications: {
      enabled: true
    }
  }
};
