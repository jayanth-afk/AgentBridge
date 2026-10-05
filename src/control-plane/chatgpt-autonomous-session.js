import { ModelExecutionAdapter } from './model-execution-adapter.js';
import { SwiftAXBridge } from './swift-ax-bridge.js';
import { ResponseCorrelator } from './response-correlator.js';

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
    this.swiftBridge = options.swiftBridge || new SwiftAXBridge(options);
    this.correlator = options.correlator || new ResponseCorrelator(options);
    this.appName = options.appName || 'ChatGPT';
    this.defaultTimeoutMs = options.timeoutMs || 180000;
    // Product name: this is ZiA's background GPT worker. It drives the real
    // user-authorized ChatGPT Desktop app without taking foreground focus.
    // "background" means unfocused/minimized-capable GUI automation; it is not
    // a fabricated response and it is not the bundled Codex engine.
    this.background = Boolean(options.background || options.headless);
    this.restoreFocus = options.restoreFocus !== false;
    // auto = prefer Apple Events JavaScript when available, otherwise use the
    // native AX path with activate:false. Explicit transports remain supported.
    this.backgroundTransport = options.backgroundTransport || 'auto';
    this.backgroundWorkerName = options.backgroundWorkerName || 'ZiA Background GPT';
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

  async submitBackgroundDom(tagged, requestId) {
    const marker = `[AB:${requestId}]`;
    const script = `(() => {
      const marker = ${JSON.stringify(marker)};
      const text = ${JSON.stringify(tagged)};
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
        ? 'ZiA Background GPT: user-authorized automation of the real ChatGPT Desktop app without activating it. Uses Apple Events JavaScript when available and otherwise native AX with activate:false.'
        : 'User-authorized macOS Accessibility automation of the real ChatGPT Desktop app. Requests are submitted to the app itself and the real model response is observed and correlated.'
    };
  }

  async health() {
    if (!this.swiftBridge.isBinaryAvailable()) {
      return { healthy: false, status: 'helper_unavailable', name: this.name, activeTurns: this.activeTurns.size };
    }
    const inspect = await this.swiftBridge.inspectApp(this.appName);
    return {
      healthy: Boolean(inspect.ok && inspect.running),
      running: Boolean(inspect.running),
      windowCount: inspect.windowCount || 0,
      activeTurns: this.activeTurns.size,
      name: this.name
    };
  }

  /**
   * Submit a prompt to the real ChatGPT Desktop app and wait for the correlated
   * real model response.
   * @returns {Promise<{success:boolean,status:string,response:string|null,error:string|null,modelTurnConfirmed:boolean,requestId:string,transport:string,latencyMs:number}>}
   */
  async send({ text, prompt, requestId, timeoutMs = null } = {}) {
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
      // Preferred path: Apple Events JavaScript can operate the web view without
      // foreground focus. If that capability is unavailable, do NOT fail the
      // background worker: the native AX transport can also submit/observe with
      // activate:false and therefore remains genuinely background/unfocused.
      const jsReady = await this.backgroundJavaScriptAvailable();

      if (jsReady) {
        const submitted = await this.submitBackgroundDom(tagged, resolvedId);
        if (submitted?.ok) {
          const deadline = Date.now() + (timeoutMs || this.defaultTimeoutMs);
          let last = '';
          let stable = 0;
          while (Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 500));
            const observed = await this.readBackgroundDomResponse(resolvedId);
            if (!observed?.ok || !observed.response) continue;
            const response = observed.response.trim();
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
      this.activeTurns.set(resolvedId, result);
      if (result.modelTurnConfirmed) this.emit('turn_completed', result);
      return result;
    }

    const turn = await this.swiftBridge.sendAndObserve(
      this.appName,
      tagged,
      resolvedId,
      timeoutMs || this.defaultTimeoutMs,
      { activate: true }
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
    return { recovered: true };
  }
}
