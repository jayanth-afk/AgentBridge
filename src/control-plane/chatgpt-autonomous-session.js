import { ModelExecutionAdapter } from './model-execution-adapter.js';
import { SwiftAXBridge } from './swift-ax-bridge.js';
import { PersistentSwiftAXBridge } from './persistent-swift-ax-bridge.js';
import { ResponseCorrelator } from './response-correlator.js';
import { ZiABackgroundGPTTarget } from './zia-background-gpt-target.js';

/**
 * ChatGptAutonomousSession:
 * Drives the REAL, user-authorized ChatGPT Desktop application through the
 * native Swift macOS Accessibility bridge. This is not the bundled Codex CLI,
 * not a headless re-implementation, and not a fabricated response: the session
 * activates the running ChatGPT.app, writes the correlated request into its
 * composer via the Accessibility API, presses the app's own Send control, then
 * observes the live accessibility tree until the model's response to this exact
 * request marker stabilises.
 *
 * The distinction is preserved deliberately:
 *   - uiSubmission        = request was entered and submitted to the UI
 *   - modelTurnConfirmed  = a correlated assistant response was actually observed
 * A turn is only reported successful once a real, correlated response exists.
 */
export class ChatGptAutonomousSession extends ModelExecutionAdapter {
  constructor(options = {}) {
    super('chatgpt-autonomous-session', options);
    // Product name: this is ZiA's background GPT worker. It drives the real
    // user-authorized ChatGPT Desktop app without taking foreground focus.
    // "background" means unfocused/minimized-capable GUI automation; it is not
    // a fabricated response and it is not the bundled Codex engine.
    this.background = Boolean(options.background || options.headless);
    this.swiftBridge = options.swiftBridge || (
      this.background
        ? new PersistentSwiftAXBridge(options)
        : new SwiftAXBridge(options)
    );
    this.correlator = options.correlator || new ResponseCorrelator(options);
    this.appName = options.appName || 'ChatGPT';
    this.defaultTimeoutMs = options.timeoutMs || 180000;
    this.restoreFocus = options.restoreFocus !== false;
    // auto = prefer Apple Events JavaScript when available, otherwise use the
    // native AX path with activate:false. Explicit transports remain supported.
    this.backgroundTransport = options.backgroundTransport || 'auto';
    this.backgroundWorkerName = options.backgroundWorkerName || 'ZiA Background GPT';
    this.backgroundTarget = this.background
      ? (options.backgroundTarget || new ZiABackgroundGPTTarget({ swiftBridge: this.swiftBridge, projectTitle: options.backgroundProjectTitle || 'ZiA Response' }))
      : null;
    this.activeTurns = new Map(); // requestId -> turnResult
  }

  /**
   * Whether the native AX bridge and the real ChatGPT process are both available.
   */
  async isAvailable() {
    if (!this.swiftBridge.isBinaryAvailable()) return false;
    const inspect = await this.swiftBridge.inspectApp(this.appName);
    return Boolean(inspect.ok && inspect.running);
  }

  async backgroundJavaScriptAvailable() {
    if (!this.background) return false;
    if (!['auto', 'apple-events-javascript'].includes(this.backgroundTransport)) return false;
    const probe = await this.swiftBridge.executeChatGPTJavaScript('document.title').catch(() => null);
    return Boolean(probe?.ok);
  }

  async primeBackgroundWindow() {
    if (!this.background || typeof this.swiftBridge.inspectElements !== 'function') {
      return { ok: false, status: 'BACKGROUND_WINDOW_PRIME_UNAVAILABLE' };
    }
    const result = await this.swiftBridge.inspectElements(this.appName);
    return result?.ok
      ? { ok: true, status: 'BACKGROUND_WINDOW_PRIMED' }
      : { ok: false, status: 'BACKGROUND_WINDOW_PRIME_FAILED', error: result?.error || 'NO_ACCESSIBLE_WINDOW' };
  }

  async verifyBackgroundNonFrontmost() {
    if (!this.background || typeof this.swiftBridge.getFrontmostApp !== 'function') {
      return { ok: false, status: 'BACKGROUND_FRONTMOST_CHECK_UNAVAILABLE' };
    }
    const frontmost = await this.swiftBridge.getFrontmostApp();
    const isChatGPTFrontmost = Boolean(
      frontmost?.ok && (
        frontmost.bundleId === 'com.openai.codex' ||
        String(frontmost.name || '').toLowerCase() === 'chatgpt'
      )
    );
    return {
      ok: !isChatGPTFrontmost,
      status: isChatGPTFrontmost ? 'CHATGPT_FRONTMOST' : 'BACKGROUND_NON_FRONTMOST',
      frontmost: frontmost?.name || null,
      frontmostPid: frontmost?.pid || null
    };
  }

  async enforceChatGPTMinimized() {
    // Compatibility no-op for callers from the minimized-era API. The new
    // invariant is enforced by never activating ChatGPT; this method must not
    // inspect or restore frontmost focus.
    return { ok: true, status: 'BACKGROUND_NON_FRONTMOST_INVARIANT' };
  }

  async submitBackgroundDom(tagged, requestId) {
    const marker = `[AB:${requestId}]`;
    const targetState = this.backgroundTarget?.state || {};
    const projectTitle = targetState.projectTitle || 'ZiA Response';
    const conversationTitle = targetState.conversationTitle || '';
    const anchorText = targetState.anchorText || '';
    const script = `(() => {
      const marker = ${JSON.stringify(marker)};
      const text = ${JSON.stringify(tagged)};
      const body = document.body?.innerText || '';
      // Hot-path target verification: do not navigate or inspect the full AX tree.
      // If the dedicated ZiA conversation is not visibly selected, fail closed.
      if (!${JSON.stringify(conversationTitle)} || !body.includes(${JSON.stringify(conversationTitle)})) {
        return JSON.stringify({ok:false,error:'BACKGROUND_TARGET_NOT_SELECTED'});
      }
      if (!body.includes(${JSON.stringify(projectTitle)})) {
        return JSON.stringify({ok:false,error:'BACKGROUND_PROJECT_NOT_VISIBLE'});
      }
      if (${JSON.stringify(Boolean(anchorText))} && !body.includes(${JSON.stringify(anchorText)})) {
        return JSON.stringify({ok:false,error:'BACKGROUND_TARGET_ANCHOR_NOT_VISIBLE'});
      }
      const candidates = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
        .filter(el => !el.disabled && el.getAttribute('aria-hidden') !== 'true');
      const input = candidates[candidates.length - 1];
      if (!input) return JSON.stringify({ok:false,error:'COMPOSER_NOT_FOUND'});
      input.focus();
      if (input instanceof HTMLTextAreaElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) setter.call(input, text); else input.value = text;
      } else {
        input.textContent = text;
      }
      input.dispatchEvent(new InputEvent('input', {bubbles:true,inputType:'insertText',data:text}));
      input.dispatchEvent(new Event('change', {bubbles:true}));
      const buttons = [...document.querySelectorAll('button')];
      const send = buttons.find(b => {
        const label = (b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').toLowerCase();
        return /send|submit/.test(label) && !/stop|cancel/.test(label) && !b.disabled;
      });
      if (!send) return JSON.stringify({ok:false,error:'SEND_BUTTON_NOT_FOUND'});
      send.click();
      return JSON.stringify({ok:true,marker});
    })()`;
    return this.swiftBridge.executeChatGPTJavaScript(script);
  }

  async readBackgroundDomResponse(requestId) {
    const marker = `[AB:${requestId}]`;
    const script = `(() => {
      const marker = ${JSON.stringify(marker)};
      const body = document.body?.innerText || '';
      const idx = body.lastIndexOf(marker);
      if (idx < 0) return JSON.stringify({ok:false,error:'MARKER_NOT_FOUND'});
      const after = body.slice(idx + marker.length).trim();
      const cleaned = after.split('ChatGPT can make mistakes')[0].split('Ask anything')[0].trim();
      return JSON.stringify({ok:true,response:cleaned});
    })()`;
    return this.swiftBridge.executeChatGPTJavaScript(script);
  }

  async capabilities() {
    const available = await this.isAvailable();
    return {
      name: this.name,
      workerName: this.background ? this.backgroundWorkerName : null,
      agent: 'chatgpt-desktop',
      engine: 'chatgpt-desktop-native-ax',
      transport: this.background ? 'chatgpt-desktop-background-ax' : 'chatgpt-desktop-accessibility',
      trueHeadlessEngine: false, // The real GUI app still performs the turn.
      backgroundModelWake: this.background,
      backgroundSubmission: this.background,
      trueIdleModelWake: available,
      idleModelWake: available,
      idleModelWakeVerdict: available ? 'VERIFIED' : 'UNSUPPORTED',
      uiSubmissionSupported: available,
      modelTurnConfirmation: available,
      modelResponseCorrelation: true,
      streaming: false,
      cancellation: false,
      concurrency: false,
      transports: this.background ? ['accessibility-background', 'apple-events-javascript'] : ['accessibility'],
      requiresUserPrompt: false,
      notes: this.background
        ? 'ZiA Background GPT: user-authorized automation of the real ChatGPT Desktop app while keeping its window minimized. Uses Apple Events JavaScript when available and otherwise native AX with activate:false.'
        : 'User-authorized macOS Accessibility automation of the real ChatGPT Desktop app. Requests are submitted to the app itself and the real model response is observed and correlated.'
    };
  }

  async health() {
    if (!this.swiftBridge.isBinaryAvailable()) {
      return { healthy: false, status: 'helper_unavailable', name: this.name, activeTurns: this.activeTurns.size };
    }
    const now = Date.now();
    if (this._cachedHealth && (now - this._cachedHealthAt < 2500)) {
      return this._cachedHealth;
    }
    const inspect = await this.swiftBridge.inspectApp(this.appName);
    const healthy = Boolean(inspect.ok && inspect.running && (inspect.windowCount > 0));
    const result = {
      healthy,
      running: Boolean(inspect.running),
      windowCount: inspect.windowCount || 0,
      activeTurns: this.activeTurns.size,
      name: this.name
    };
    this._cachedHealth = result;
    this._cachedHealthAt = now;
    return result;
  }

  /**
   * Submit a prompt to the real ChatGPT Desktop app and wait for the correlated
   * real model response.
   * @returns {Promise<{success:boolean,status:string,response:string|null,error:string|null,modelTurnConfirmed:boolean,requestId:string,transport:string,latencyMs:number}>}
   */
  async send({ text, prompt, requestId, timeoutMs = null, onChunk = null } = {}) {
    const resolvedId = requestId || `req_cg_ui_${Date.now()}`;
    const resolvedText = text || prompt || '';
    const startMs = Date.now();

    if (!resolvedText.trim()) {
      return {
        success: false,
        status: 'EMPTY_REQUEST',
        error: 'EMPTY_REQUEST',
        response: null,
        modelTurnConfirmed: false,
        requestId: resolvedId,
        transport: 'chatgpt-desktop-accessibility',
        latencyMs: 0
      };
    }

    if (!this.swiftBridge.isBinaryAvailable()) {
      return {
        success: false,
        status: 'CHATGPT_ACCESSIBILITY_UNAVAILABLE',
        error: 'Swift AX helper binary is not available',
        response: null,
        modelTurnConfirmed: false,
        requestId: resolvedId,
        transport: 'chatgpt-desktop-accessibility',
        latencyMs: Date.now() - startMs
      };
    }

    // Embed the compact correlation marker the AX extractor matches on.
    const tagged = this.correlator.tagMessage(resolvedText, resolvedId);

    if (this.background) {
      // Background GPT has a stricter invariant than ordinary focus
      // preservation: ChatGPT must remain minimized while ZiA uses it.
      await this.enforceChatGPTMinimized();

      try {
        // Fail closed on target identity. A background worker must never send to
        // whatever chat happens to be open.
      if (!this.backgroundTarget) {
        return {
          success: false,
          status: 'BACKGROUND_TARGET_UNAVAILABLE',
          error: 'ZiA Background GPT target resolver is not configured',
          response: null,
          modelTurnConfirmed: false,
          requestId: resolvedId,
          transport: 'chatgpt-desktop-background-ax',
          uiSubmitted: false,
          latencyMs: Date.now() - startMs
        };
      }
      const target = await this.backgroundTarget.resolvePersisted();
      if (!target.ok) {
        return {
          success: false,
          status: target.status,
          error: target.error,
          response: null,
          modelTurnConfirmed: false,
          requestId: resolvedId,
          transport: 'chatgpt-desktop-background-ax',
          uiSubmitted: false,
          target,
          latencyMs: Date.now() - startMs
        };
      }

      // Reassert minimized state after target resolution because navigation
      // is one of the operations most likely to restore the window.
      await this.enforceChatGPTMinimized();

      // Preferred path: Apple Events JavaScript can operate the web view without
      // foreground focus. If that capability is unavailable, do NOT fail the
      // background worker: the native AX transport can also submit/observe with
      // activate:false and therefore remains genuinely background/unfocused.
      const jsReady = await this.backgroundJavaScriptAvailable();

      if (jsReady) {
        const submitted = await this.submitBackgroundDom(tagged, resolvedId);
        await this.enforceChatGPTMinimized();
        if (submitted?.ok) {
          const deadline = Date.now() + (timeoutMs || this.defaultTimeoutMs);
          let last = '';
          let stable = 0;
          let streamedLen = 0;
          while (Date.now() < deadline) {
            const sleepMs = last ? 80 : 50;
            await new Promise(resolve => setTimeout(resolve, sleepMs));
            const observed = await this.readBackgroundDomResponse(resolvedId);
            if (!observed?.ok || !observed.response) continue;
            const response = observed.response.trim();
            if (response.length > streamedLen) {
              const delta = response.slice(streamedLen);
              streamedLen = response.length;
              if (typeof onChunk === 'function') {
                try { onChunk(delta); } catch {}
              }
            }
            if (response === last) stable += 1;
            else { last = response; stable = 0; }
            if (stable >= 2) {
              const result = {
                success: true,
                status: 'COMPLETED',
                response,
                error: null,
                modelTurnConfirmed: true,
                requestId: resolvedId,
                transport: 'chatgpt-desktop-background-javascript',
                uiSubmitted: true,
                latencyMs: Date.now() - startMs
              };
              // Dedicated-Space mode intentionally leaves ChatGPT open and non-frontmost.
              this.activeTurns.set(resolvedId, result);
              this.emit('turn_completed', result);
              return result;
            }
          }
          return {
            success: false,
            status: 'BACKGROUND_RESPONSE_TIMEOUT',
            error: 'ChatGPT accepted the background request but no stable correlated response was observed before timeout',
            response: last || null,
            modelTurnConfirmed: false,
            requestId: resolvedId,
            transport: 'chatgpt-desktop-background-javascript',
            uiSubmitted: true,
            latencyMs: Date.now() - startMs
          };
        }
      }

      if (this.backgroundTransport === 'apple-events-javascript') {
        return {
          success: false,
          status: 'BACKGROUND_MODEL_UNAVAILABLE',
          error: 'ChatGPT Apple Events JavaScript transport is unavailable',
          response: null,
          modelTurnConfirmed: false,
          requestId: resolvedId,
          transport: 'chatgpt-desktop-background-javascript',
          uiSubmitted: false,
          latencyMs: Date.now() - startMs
        };
      }

      // Native fallback: no app activation, no focus stealing.
      const turn = await this.swiftBridge.sendAndObserve(
        this.appName,
        tagged,
        resolvedId,
        timeoutMs || this.defaultTimeoutMs,
        { activate: false }
      );
      if (typeof onChunk === 'function' && turn.ok && turn.response) {
        try { onChunk(turn.response); } catch {}
      }
      const result = {
        success: Boolean(turn.ok && turn.response),
        status: turn.status || (turn.ok ? 'COMPLETED' : 'UNKNOWN'),
        response: turn.response || null,
        error: turn.error || null,
        modelTurnConfirmed: Boolean(turn.ok && turn.response),
        requestId: resolvedId,
        transport: 'chatgpt-desktop-background-ax',
        uiSubmitted: !['APP_NOT_RUNNING', 'NO_WINDOW', 'CHATGPT_COMPOSER_NOT_FOUND'].includes(turn.status),
        latencyMs: Date.now() - startMs
      };
      // Dedicated-Space mode intentionally leaves ChatGPT open and non-frontmost.
      this.activeTurns.set(resolvedId, result);
      if (result.modelTurnConfirmed) this.emit('turn_completed', result);
      return result;
      } finally {
        // Never leave ChatGPT in the foreground merely because ZiA used it.
        // If the user deliberately switched to another app during the turn,
        // preserve that newer choice instead of stealing focus back.
        await this.enforceChatGPTMinimized();
      }
    }

    const shouldActivate = typeof activate === 'boolean'
      ? activate
      : (typeof this.options.activate === 'boolean' ? this.options.activate : true);

    const turn = await this.swiftBridge.sendAndObserve(
      this.appName,
      tagged,
      resolvedId,
      timeoutMs || this.defaultTimeoutMs,
      { activate: shouldActivate }
    );

    const result = {
      success: Boolean(turn.ok && turn.response),
      status: turn.status || (turn.ok ? 'COMPLETED' : 'UNKNOWN'),
      response: turn.response || null,
      error: turn.error || null,
      // Only true when a correlated response was actually observed.
      modelTurnConfirmed: Boolean(turn.ok && turn.response),
      requestId: resolvedId,
      transport: 'chatgpt-desktop-accessibility',
      uiSubmitted: !['APP_NOT_RUNNING', 'NO_WINDOW', 'CHATGPT_COMPOSER_NOT_FOUND'].includes(turn.status),
      latencyMs: Date.now() - startMs
    };

    this.activeTurns.set(resolvedId, result);
    this.emit('turn_completed', result);
    return result;
  }

  async cancel(requestId) {
    // The accessibility transport cannot safely cancel an in-flight native turn
    // without risking interrupting an unrelated user action. We release our
    // bookkeeping only and report honestly.
    const existed = this.activeTurns.delete(requestId);
    return { cancelled: false, requestId, released: existed, reason: 'UI_CANCEL_UNSUPPORTED' };
  }

  async recover() {
    this.activeTurns.clear();
    if (this.background && this.backgroundTarget) {
      const target = await this.backgroundTarget.resolvePersisted();
      if (!target.ok) return { recovered: false, target };
      return { recovered: true, target };
    }
    return { recovered: true };
  }
}
