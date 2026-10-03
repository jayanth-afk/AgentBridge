import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SwiftAXBridge } from './swift-ax-bridge.js';
import { ConversationLocator } from './conversation-locator.js';

const execFileAsync = promisify(execFile);

/**
 * Desktop Session States
 */
export const SessionState = Object.freeze({
  ACTIVE_MODEL_TURN: 'ACTIVE_MODEL_TURN',
  ACCESSIBLE_WINDOW: 'ACCESSIBLE_WINDOW',
  CDP_SESSION: 'CDP_SESSION',
  BROWSER_SESSION: 'BROWSER_SESSION',
  RUNNING_BUT_HIDDEN: 'RUNNING_BUT_HIDDEN',
  RUNNING_BUT_WINDOWLESS: 'RUNNING_BUT_WINDOWLESS',
  OFFLINE: 'OFFLINE'
});

/**
 * Focus Policies
 */
export const FocusPolicy = Object.freeze({
  WHEN_REQUIRED: 'when-required',
  NEVER: 'never',
  ALWAYS: 'always'
});

/**
 * PersistentDesktopSessionManager:
 * Keeps desktop application sessions accessible, maintains dedicated agent conversations,
 * and restores user focus after interaction to prevent disrupting the user's workflow.
 */
export class PersistentDesktopSessionManager {
  constructor(options = {}) {
    this.options = options;
    this.swiftBridge = options.swiftBridge || new SwiftAXBridge(options);
    this.locator = options.locator || new ConversationLocator(options);
    this.focusPolicy = options.focusPolicy || FocusPolicy.WHEN_REQUIRED;
    this.dedicatedConversationName = options.dedicatedConversationName || 'Agent Bridge';

    // Track dedicated conversation IDs: targetApp -> conversationMeta
    this.dedicatedSessions = new Map();
  }

  /**
   * Determine exact session state for target application
   */
  async getSessionState(targetApp) {
    const inspect = await this.swiftBridge.inspectApp(targetApp);
    if (!inspect.ok || !inspect.running) {
      return SessionState.OFFLINE;
    }

    if (inspect.windowCount === 0) {
      return SessionState.RUNNING_BUT_WINDOWLESS;
    }

    // Window exists: verify accessibility
    const conv = await this.locator.findActiveConversation({ targetApp });
    if (conv.unambiguous) {
      return SessionState.ACCESSIBLE_WINDOW;
    }

    return SessionState.RUNNING_BUT_HIDDEN;
  }

  /**
   * Ensure application is running. If not, launches it.
   */
  async ensureRunning(targetApp) {
    const inspect = await this.swiftBridge.inspectApp(targetApp);
    if (inspect.ok && inspect.running) {
      return { ok: true, running: true, pid: inspect.pid };
    }

    try {
      await execFileAsync('open', ['-a', targetApp]);
      await new Promise(r => setTimeout(r, 1200));
      const verify = await this.swiftBridge.inspectApp(targetApp);
      return { ok: verify.running, running: verify.running, pid: verify.pid };
    } catch (err) {
      return { ok: false, running: false, error: err.message };
    }
  }

  /**
   * Ensure application has an accessible window. Restores if windowless.
   */
  async ensureWindow(targetApp) {
    await this.ensureRunning(targetApp);
    let inspect = await this.swiftBridge.inspectApp(targetApp);

    if (inspect.ok && inspect.windowCount > 0) {
      return { ok: true, windowCount: inspect.windowCount, windows: inspect.windows };
    }

    // Try native unhide & reopen
    await this.swiftBridge.unhideApp(targetApp);
    try {
      await execFileAsync('open', ['-a', targetApp]);
      await new Promise(r => setTimeout(r, 800));
    } catch {}

    inspect = await this.swiftBridge.inspectApp(targetApp);
    if (inspect.ok && inspect.windowCount > 0) {
      return { ok: true, windowCount: inspect.windowCount, windows: inspect.windows, restored: true };
    }

    return {
      ok: false,
      windowCount: 0,
      error: 'WINDOW_RESTORE_FAILED',
      details: `${targetApp} is running but did not present an accessible window.`
    };
  }

  /**
   * Ensure dedicated Agent Bridge conversation is active
   */
  async ensureConversation(targetApp, dedicatedName = null) {
    const name = dedicatedName || this.dedicatedConversationName;
    const windowRes = await this.ensureWindow(targetApp);
    if (!windowRes.ok) {
      return { ok: false, error: windowRes.error };
    }

    const active = await this.locator.findActiveConversation({ targetApp });
    if (!active.unambiguous) {
      return { ok: false, error: active.status || 'TARGET_AMBIGUOUS' };
    }

    // Store dedicated session record
    const meta = {
      app: targetApp,
      conversationTitle: active.conversation.title || name,
      windowTitle: active.conversation.windowTitle,
      confirmedAt: new Date().toISOString()
    };
    this.dedicatedSessions.set(targetApp, meta);

    return {
      ok: true,
      dedicated: true,
      conversation: meta
    };
  }

  /**
   * Capture user's currently focused foreground app before interaction
   */
  async captureUserFocus() {
    if (this.focusPolicy === FocusPolicy.NEVER) return null;
    const front = await this.swiftBridge.getFrontmostApp();
    return front.ok ? { name: front.name, pid: front.pid, bundleId: front.bundleId } : null;
  }

  /**
   * Restore user's previous focus after interaction completes
   */
  async restoreUserFocus(previousFocus) {
    if (!previousFocus || !previousFocus.pid) return { restored: false };
    if (this.focusPolicy === FocusPolicy.NEVER) return { restored: false, policy: 'never' };

    try {
      const res = await this.swiftBridge.restoreFocus(previousFocus.pid);
      return { restored: res.ok, restoredTo: previousFocus.name };
    } catch {
      return { restored: false };
    }
  }
}
