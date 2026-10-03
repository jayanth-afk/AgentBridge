import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { SwiftAXBridge } from './swift-ax-bridge.js';
import { RegistrySessionState } from './persistent-session-registry.js';

const execFileAsync = promisify(execFile);

/**
 * PersistentDesktopLauncher:
 * Safe, user-authorized launcher and window lifecycle controller for desktop agents.
 * Supports launching with optional debugging flags (e.g. CDP port), restoring windowless processes,
 * and registering verified live sessions.
 */
export class PersistentDesktopLauncher {
  constructor(options = {}) {
    this.options = options;
    this.swiftBridge = options.swiftBridge || new SwiftAXBridge(options);
    this.registry = options.registry || null;
    this.launchTimeoutMs = options.launchTimeoutMs || 5000;
  }

  /**
   * Ensure desktop application is launched and ready
   */
  async ensureAppReady(targetApp, { debugPort = null, agentId = null } = {}) {
    // 1. Check if app is already running
    let inspection = await this.swiftBridge.inspectApp(targetApp);

    if (inspection.ok && inspection.running) {
      // If running and has windows, verify
      if (inspection.windowCount > 0) {
        return this._recordReadySession(targetApp, inspection, { agentId, restored: false });
      }

      // Running but windowless: unhide and open to trigger window recreation
      await this.swiftBridge.unhideApp(targetApp);
      try {
        await execFileAsync('open', ['-a', targetApp]);
        await new Promise(r => setTimeout(r, 600));
      } catch {}

      inspection = await this.swiftBridge.inspectApp(targetApp);
      return this._recordReadySession(targetApp, inspection, { agentId, restored: true });
    }

    // 2. App is not running: launch it
    if (debugPort && targetApp.toLowerCase() === 'claude') {
      // Launch Claude with remote debugging port directly
      const child = spawn('/Applications/Claude.app/Contents/MacOS/Claude', [
        `--remote-debugging-port=${debugPort}`
      ], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
    } else {
      // Standard macOS launch
      await execFileAsync('open', ['-a', targetApp]);
    }

    // Wait for process readiness
    const start = Date.now();
    while (Date.now() - start < this.launchTimeoutMs) {
      await new Promise(r => setTimeout(r, 400));
      inspection = await this.swiftBridge.inspectApp(targetApp);
      if (inspection.ok && inspection.running) {
        break;
      }
    }

    if (!inspection.running) {
      return {
        ok: false,
        error: 'LAUNCH_TIMEOUT',
        app: targetApp,
        details: `Application ${targetApp} did not report running within ${this.launchTimeoutMs}ms.`
      };
    }

    return this._recordReadySession(targetApp, inspection, { agentId, launched: true });
  }

  _recordReadySession(targetApp, inspection, { agentId = null, restored = false, launched = false }) {
    const resolvedAgent = agentId || (targetApp.toLowerCase().includes('claude') ? 'claude' : 'chatgpt');
    const state = inspection.windowCount > 0 ? RegistrySessionState.ACCESSIBLE : RegistrySessionState.WINDOWLESS;

    let sessionRecord = null;
    if (this.registry) {
      const existing = this.registry.findSessionForAgent(resolvedAgent);
      if (existing) {
        sessionRecord = this.registry.updateSessionState(existing.sessionId, state, {
          pid: inspection.pid,
          windowCount: inspection.windowCount
        });
      } else {
        sessionRecord = this.registry.registerSession({
          agentId: resolvedAgent,
          application: targetApp,
          pid: inspection.pid,
          state,
          windowId: inspection.windows[0] || null
        });
      }
    }

    return {
      ok: true,
      app: targetApp,
      agentId: resolvedAgent,
      pid: inspection.pid,
      windowCount: inspection.windowCount,
      windows: inspection.windows,
      state,
      restored,
      launched,
      session: sessionRecord
    };
  }
}
