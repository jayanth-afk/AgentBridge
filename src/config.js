import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveSecret, loadKeychainSecret } from './config-resolver.js';
import { REGISTERED_VERIFICATION_TOKENS } from './security/verification-tokens.js';
import { listAllAgentManifests } from './capabilities/agent-manifest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BRIDGE_ROOT = path.resolve(__dirname, '..');

export const CONFIG = {
  BRIDGE_ROOT,
  DATA_DIR: path.join(BRIDGE_ROOT, 'data'),
  DB_PATH: process.env.AGENT_BRIDGE_DB_PATH || path.join(BRIDGE_ROOT, 'data', 'bridge.sqlite'),
  TEST_WORKSPACE: path.join(BRIDGE_ROOT, 'test-workspace'),
  ZIA_ROOT: '/Users/jayanthpranaykonada/Zia',
  
  // Registered non-sensitive verification tokens for Agent Bridge interoperability tests
  VERIFICATION_TOKENS: REGISTERED_VERIFICATION_TOKENS,
  
  // Zia main working tree write-lock protection (defaults to TRUE to protect Zia from any mutation)
  ZIA_WRITE_LOCKED: process.env.ZIA_WRITE_LOCKED !== undefined
    ? process.env.ZIA_WRITE_LOCKED !== 'false' && process.env.ZIA_WRITE_LOCKED !== '0'
    : true,

  // Default allowed roots: repo root and test-workspace.
  // Extra roots come from an explicit user config file (config/allowed-roots.json) or environment variables.
  // Full home directory access is disabled by default to prevent unintended mutations.
  ALLOWED_ROOTS: (() => {
    if (process.env.AGENT_BRIDGE_ALLOW_HOME_ROOT === '1') {
      return [path.join(BRIDGE_ROOT, 'test-workspace'), os.homedir()];
    }
    if (process.env.AGENT_BRIDGE_ALLOWED_ROOTS) {
      return process.env.AGENT_BRIDGE_ALLOWED_ROOTS.split(',').map(s => s.trim()).filter(Boolean);
    }
    const userRootsFile = [
      path.join(BRIDGE_ROOT, 'config', 'allowed-roots.json'),
      path.join(BRIDGE_ROOT, 'data', 'allowed-roots.json')
    ].find(p => fs.existsSync(p));

    if (userRootsFile) {
      try {
        const parsed = JSON.parse(fs.readFileSync(userRootsFile, 'utf8'));
        if (Array.isArray(parsed) && parsed.length > 0) {
          return [
            BRIDGE_ROOT,
            path.join(BRIDGE_ROOT, 'test-workspace'),
            ...parsed.map(r => path.resolve(BRIDGE_ROOT, r))
          ];
        }
      } catch {
        // swallow-ok: fallback to defaults if config file is invalid
      }
    }

    return [
      BRIDGE_ROOT,
      path.join(BRIDGE_ROOT, 'test-workspace')
    ];
  })(),

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
    const envKey = process.env.CONTROL_PLANE_API_KEY_CONFIG ?? process.env.AGENT_BRIDGE_API_KEY ?? process.env.CONTROL_PLANE_API_KEY;
    const hasEnvKey = Boolean(envKey && !isPlaceholder(envKey));
    let rawKey = envKey;
    if (isPlaceholder(rawKey)) rawKey = null;

    // Check persistent 0600 keyfile in data directory
    const keyFilePath = path.join(BRIDGE_ROOT, 'data', '.control_plane_key');
    if (!rawKey && fs.existsSync(keyFilePath)) {
      try {
        const fileContent = fs.readFileSync(keyFilePath, 'utf8').trim();
        if (fileContent && !isPlaceholder(fileContent)) {
          rawKey = fileContent;
        }
      } catch {
        // swallow-ok: ignore file read errors
      }
    }

    if (!rawKey && process.platform === 'darwin') {
      const keychainSecret = loadKeychainSecret('agent-bridge', 'control_plane_api_key');
      if (keychainSecret) rawKey = keychainSecret;
    }

    // Fresh install detection: no existing database and no key configured
    const dbPath = process.env.AGENT_BRIDGE_DB_PATH || path.join(BRIDGE_ROOT, 'data', 'bridge.sqlite');
    const isFreshInstall = !fs.existsSync(dbPath) && !fs.existsSync(keyFilePath);
    if (!rawKey && isFreshInstall && process.env.NODE_ENV !== 'test' && process.env.AGENT_BRIDGE_DISABLE_AUTO_KEY !== '1') {
      try {
        const generatedKey = crypto.randomBytes(24).toString('hex');
        const dataDir = path.join(BRIDGE_ROOT, 'data');
        if (!fs.existsSync(dataDir)) {
          fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        }
        fs.writeFileSync(keyFilePath, generatedKey, { mode: 0o600 });
        rawKey = generatedKey;
      } catch {
        // swallow-ok: fallback if disk is read-only
      }
    }

    const requireFlag = process.env.CONTROL_PLANE_REQUIRE_API_KEY;
    const requireApiKey = requireFlag !== undefined
      ? (requireFlag === '1' || requireFlag === 'true')
      : Boolean(hasEnvKey || rawKey);
    return {
      API_KEY: resolveSecret(rawKey, { name: 'control_plane.api_key' }),
      REQUIRE_API_KEY: requireApiKey
    };
  })(),

  // Legacy compatibility: allow a bound connection to *act as* a different
  // known identity. Off by default because it is an impersonation vector.
  // Operators that truly need it can set AGENT_BRIDGE_ALLOW_IDENTITY_COMPATIBILITY=1.
  // Maximum pending age policy (AR-03): pending work older than this is expired to failed with TARGET_UNREACHABLE.
  // Configurable via AGENT_BRIDGE_MAX_PENDING_AGE_MS (default 24h). Set to 0 to disable.
  MAX_PENDING_AGE_MS: process.env.AGENT_BRIDGE_MAX_PENDING_AGE_MS !== undefined
    ? Number(process.env.AGENT_BRIDGE_MAX_PENDING_AGE_MS)
    : (24 * 60 * 60 * 1000),

  // Known agent identities (dynamically incorporates all registered agent manifests)
  get AGENT_IDENTITIES() {
    const base = [
      'chatgpt-desktop',
      'claude-desktop',
      'zia',
      'antigravity-ide',
      'gemini',
      'freebuff',
      'system'
    ];
    try {
      const manifests = listAllAgentManifests();
      const set = new Set(base);
      for (const m of manifests) {
        if (m.agentId) set.add(m.agentId.toLowerCase());
      }
      return Array.from(set);
    } catch {
      return base;
    }
  },

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
  // Git mutation allowlist: default-deny for all agent identities.
  // Must be explicitly configured by a human (e.g. via AGENT_BRIDGE_GIT_ALLOWED_AGENTS).
  GIT_MUTATION_ALLOWED_AGENTS: process.env.AGENT_BRIDGE_GIT_ALLOWED_AGENTS
    ? process.env.AGENT_BRIDGE_GIT_ALLOWED_AGENTS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : [],

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
