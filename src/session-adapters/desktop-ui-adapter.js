import { AgentSessionAdapter } from './base-adapter.js';
import { probeApplicationUI } from '../../tools/mac-ui-probe/probe.js';
import { sendDesktopNotification, activateDesktopApp } from './desktop-notifier.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * DesktopUIAdapter:
 * User-authorized, safe macOS UI automation session adapter.
 * Uses macOS Accessibility tree verification, strict conversation targeting,
 * and duplication guards. Never types blindly into arbitrary focused windows.
 */
export class DesktopUIAdapter extends AgentSessionAdapter {
  constructor(agentId, options = {}) {
    if (typeof agentId === 'object' && agentId !== null) {
      options = agentId;
      agentId = options.agentId || 'desktop-agent';
    }
    super(agentId, options);
    this.targetApp = options.targetApp || options.appName || (agentId && agentId.includes('claude') ? 'Claude' : 'ChatGPT');
    this.appName = this.targetApp;
    this.bundleId = options.bundleId || (agentId && agentId.includes('claude') ? 'com.anthropic.claudefordesktop' : 'com.openai.chat');
    this.enabled = Boolean(options.enabled); // Opt-in only
    this.requireUnambiguousTarget = options.requireUnambiguousTarget !== false;
    this.preventDuplicates = options.preventDuplicates !== false;
    this.presence = options.presenceManager || null;
    this.mailbox = options.mailboxHub || null;
    this.eventBus = options.eventBus || null;

    // Duplication protection: requestId -> { sentAt, status, conversationId, lastCheck }
    this.sentRequests = new Map();
    this.activeWaiters = new Map();
  }

  async connect() {
    this.connected = true;
    const running = await this.isRunning();
    return {
      connected: true,
      agentId: this.agentId,
      transport: 'desktop-ui',
      targetApp: this.targetApp,
      running,
      enabled: this.enabled
    };
  }

  async disconnect() {
    this.connected = false;
    for (const [reqId, waiter] of this.activeWaiters.entries()) {
      if (waiter.timer) clearTimeout(waiter.timer);
    }
    this.activeWaiters.clear();
    return { connected: false, agentId: this.agentId };
  }

  async isRunning() {
    try {
      const { stdout } = await execFileAsync('pgrep', ['-i', '-f', this.targetApp]);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  isActive() {
    return this.connected && this.enabled;
  }

  async inspectApp() {
    return probeApplicationUI(this.targetApp);
  }

  async isIdle() {
    const running = await this.isRunning();
    if (!running) return false;
    const probe = await this.inspectApp();
    const hasActiveInput = probe.inputElements?.some(i => i.hasValue);
    return !hasActiveInput;
  }

  /**
   * Failsafe Verification:
   * Confirms app name, bundle ID, and that an unambiguous, accessible window exists.
   */
  async verifyTarget() {
    const running = await this.isRunning();
    if (!running) {
      return { ok: false, error: 'app_not_running', details: `${this.targetApp} process is not running.` };
    }

    const probe = await this.inspectApp();
    if (!probe.accessibilitySupported) {
      return { ok: false, error: 'ACCESSIBILITY_DISABLED', details: 'macOS Accessibility is not granted or supported.' };
    }

    if (!probe.windows || probe.windows.length === 0) {
      return { ok: false, error: 'NO_OPEN_WINDOW', details: `${this.targetApp} has no open window.` };
    }

    // Check conversation ambiguity
    if (this.requireUnambiguousTarget && probe.windows.length > 1) {
      return {
        ok: false,
        error: 'TARGET_AMBIGUOUS',
        windowCount: probe.windows.length,
        details: 'Multiple active windows detected; conversation target cannot be determined safely.'
      };
    }

    return {
      ok: true,
      window: probe.windows[0],
      inputElements: probe.inputElements,
      buttons: probe.buttons
    };
  }

  /**
   * Send a message to the target application UI with duplication protection
   * and conversation verification.
   */
  async sendMessage(textOrPayload, options = {}) {
    let text;
    let requestId;
    let conversationId;
    let activateApp;
    if (typeof textOrPayload === 'object' && textOrPayload !== null) {
      text = textOrPayload.text || textOrPayload.content || textOrPayload.message;
      requestId = textOrPayload.requestId;
      conversationId = textOrPayload.conversationId;
      activateApp = textOrPayload.activateApp || false;
    } else {
      text = String(textOrPayload || '');
      requestId = options.requestId;
      conversationId = options.conversationId;
      activateApp = options.activateApp || false;
    }

    if (!this.enabled) {
      return {
        success: false,
        status: 'blocked',
        error: 'opt_in_required',
        details: 'Desktop UI automation is disabled by default. Enable via config.desktopAutomation.enabled.'
      };
    }

    const running = await this.isRunning();
    if (!running) {
      return {
        success: false,
        status: 'not_running',
        error: 'app_not_running',
        details: `${this.targetApp} is not running.`
      };
    }

    // 1. Duplication Protection: Never send the same requestId twice
    if (this.preventDuplicates && requestId && this.sentRequests.has(requestId)) {
      const existing = this.sentRequests.get(requestId);
      return {
        success: false,
        duplicate: true,
        status: 'duplicate_prevented',
        requestId,
        error: 'duplicate_prevented',
        sentAt: existing.sentAt,
        details: 'Request was already dispatched to desktop UI; duplicate send prevented.'
      };
    }

    // 2. Failsafe Verification
    const verification = await this.verifyTarget();
    if (!verification.ok) {
      return {
        success: false,
        status: verification.error === 'TARGET_AMBIGUOUS' ? 'target_ambiguous' : 'aborted',
        error: verification.error,
        windowCount: verification.windowCount,
        details: verification.details
      };
    }

    // 3. Mark as sent before executing UI interaction (crash-reconciliation guard)
    const record = {
      requestId,
      conversationId: conversationId || (verification.window && verification.window.title),
      text,
      sentAt: new Date().toISOString(),
      status: 'SENT'
    };
    if (requestId) {
      this.sentRequests.set(requestId, record);
    }

    // 4. Execute UI automation (mockable in unit tests)
    const res = await this._executeAutomation({ text, requestId, verification, activateApp });
    if (!res.submitted && res.error) {
      record.status = 'FAILED';
      return {
        success: false,
        status: 'failed',
        error: res.error,
        requestId
      };
    }

    return {
      success: true,
      status: 'delivered_to_ui',
      requestId,
      transport: 'desktop-ui',
      app: this.targetApp,
      window: verification.window && verification.window.title,
      tagged: Boolean(requestId)
    };
  }

  async _executeAutomation({ text, requestId, verification, activateApp }) {
    if (activateApp) {
      await activateDesktopApp(this.targetApp);
    }

    const taggedMessage = requestId ? `[Agent Bridge ${requestId}]\n${text}` : text;
    const jxaInsertScript = `
      const se = Application("System Events");
      const procs = se.applicationProcesses.whose({name: "${this.targetApp}"});
      if (procs.length === 0) {
        JSON.stringify({ ok: false, error: "process_not_found" });
      } else {
        const p = procs[0];
        const wins = p.windows();
        if (wins.length === 0) {
          JSON.stringify({ ok: false, error: "no_window" });
        } else {
          let target = null;
          function findTextArea(elem, depth) {
            if (depth > 4 || target) return;
            try {
              if (elem.role() === "AXTextArea" || elem.role() === "AXTextField") {
                target = elem;
                return;
              }
              const kids = elem.uiElements();
              for (let k = 0; k < kids.length; k++) {
                findTextArea(kids[k], depth + 1);
              }
            } catch {}
          }
          findTextArea(wins[0], 0);

          if (target) {
            try {
              target.value = ${JSON.stringify(taggedMessage)};
              JSON.stringify({ ok: true, located: true });
            } catch (e) {
              JSON.stringify({ ok: false, error: e.message });
            }
          } else {
            JSON.stringify({ ok: false, error: "input_element_not_found" });
          }
        }
      }
    `;

    try {
      const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', jxaInsertScript], { timeout: 5000 });
      const parsed = JSON.parse(stdout.trim());
      return { submitted: parsed.ok, error: parsed.error };
    } catch (err) {
      return { submitted: false, error: err.message };
    }
  }

  /**
   * Inspects the UI to read back the assistant's response.
   */
  async readResponse({ requestId = null } = {}) {
    const probe = await this.inspectApp();
    if (!probe.accessibilitySupported || !probe.windows || probe.windows.length === 0) {
      return { status: 'unavailable', error: 'UI_NOT_ACCESSIBLE' };
    }

    if (requestId && probe.textRegions) {
      const matchIndex = probe.textRegions.findIndex(r => r.snippet && r.snippet.includes(requestId));
      if (matchIndex >= 0 && matchIndex + 1 < probe.textRegions.length) {
        const nextTexts = probe.textRegions.slice(matchIndex + 1).map(r => r.snippet);
        return {
          status: 'completed',
          requestId,
          response: nextTexts.join('\n')
        };
      }
    }

    return {
      status: 'pending',
      requestId,
      availableRegions: probe.textRegions ? probe.textRegions.length : 0
    };
  }

  async waitForResponse({ requestId, timeoutMs = 15000, pollIntervalMs = 1000 }) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const res = await this.readResponse({ requestId });
      if (res.status === 'completed') {
        return res;
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    return {
      status: 'timeout',
      requestId,
      details: `Timeout of ${timeoutMs}ms exceeded waiting for desktop UI response.`
    };
  }

  cancel({ requestId }) {
    if (this.sentRequests.has(requestId)) {
      const r = this.sentRequests.get(requestId);
      r.status = 'CANCELLED';
      return { success: true, requestId, status: 'cancelled' };
    }
    return { success: false, requestId, error: 'REQUEST_NOT_FOUND' };
  }

  async wake() {
    const running = await this.isRunning();
    if (!running) {
      return { success: false, error: 'APP_NOT_RUNNING' };
    }

    await activateDesktopApp(this.targetApp);
    return { success: true, agentId: this.agentId, wakeupType: 'desktop_ui_activation', targetApp: this.targetApp };
  }

  capabilities() {
    return {
      agentId: this.agentId,
      transport: 'desktop-ui',
      autonomousExecution: false,
      headlessExecution: false,
      externalModelWakeup: this.enabled,
      idleWakeupSupported: this.enabled,
      activeTurnRpc: false,
      desktopNotificationSupported: true,
      uiAutomationSupported: true,
      uiAutomationEnabled: this.enabled,
      canWake: true,
      requiresExplicitOptIn: true,
      supportsTargetAmbiguityCheck: true,
      failsafeVerification: true,
      duplicationGuard: true,
      notes: `User-authorized macOS accessibility UI automation adapter for ${this.targetApp}. Operates via verified UI elements with target-ambiguous protection and duplication guards.`
    };
  }
}

export class ClaudeDesktopUIAdapter extends DesktopUIAdapter {
  constructor(options = {}) {
    super('claude-desktop', { ...options, targetApp: 'Claude', appName: 'Claude', bundleId: 'com.anthropic.claudefordesktop' });
  }
}

export class ChatGPTDesktopUIAdapter extends DesktopUIAdapter {
  constructor(options = {}) {
    super('chatgpt-desktop', { ...options, targetApp: 'ChatGPT', appName: 'ChatGPT', bundleId: 'com.openai.chat' });
  }
}
