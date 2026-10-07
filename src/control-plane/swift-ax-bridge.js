import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HELPER_DIR = path.resolve(__dirname, '../../tools/macos-accessibility-helper');
const BUILT_HELPER_BIN = path.join(HELPER_DIR, '.build/out/Products/Release/bridge-ax-helper');
const CHECKED_IN_HELPER_BIN = path.join(HELPER_DIR, 'bridge-ax-helper');
const HELPER_BIN = fs.existsSync(BUILT_HELPER_BIN) ? BUILT_HELPER_BIN : CHECKED_IN_HELPER_BIN;

/**
 * SwiftAXBridge:
 * High-performance native macOS Accessibility bridge using the compiled Swift helper.
 * Provides sub-5ms process and window discovery, falling back to JXA if the binary is absent.
 */
export class SwiftAXBridge {
  constructor(options = {}) {
    this.options = options;
    this.binaryPath = options.binaryPath || HELPER_BIN;
    this.keepAlive = Boolean(options.keepAlive);
  }

  isBinaryAvailable() {
    try {
      return fs.existsSync(this.binaryPath);
    } catch {
      return false;
    }
  }

  async executeOp(opObj) {
    if (!this.isBinaryAvailable()) {
      return { ok: false, error: 'SWIFT_BINARY_NOT_FOUND' };
    }

    const timeoutMs = (opObj.timeoutMs || 4000) + 2000;
    try {
      const { stdout } = await execFileAsync(this.binaryPath, [JSON.stringify(opObj)], { timeout: timeoutMs });
      return JSON.parse(stdout.trim());
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async pressChatGPTButton(title) {
    return this.executeOp({ op: 'chatgptPressButton', app: 'ChatGPT', text: title, timeoutMs: 5000 });
  }

  async setChatGPTMinimized(minimized) {
    return this.executeOp({ op: 'setMinimized', app: 'ChatGPT', minimized: Boolean(minimized), timeoutMs: 5000 });
  }

  async executeChatGPTJavaScript(javascript) {
    const result = await this.executeOp({ op: 'chatgptExecuteJavaScript', text: javascript, timeoutMs: 10000 });
    if (result?.ok && typeof result.result === 'string') {
      try {
        const parsed = JSON.parse(result.result);
        return parsed && typeof parsed === 'object' ? { ...result, ...parsed } : result;
      } catch {
        // Plain string JavaScript results remain valid.
      }
    }
    return result;
  }

  async sendPrompt(appName, text, requestId) {
    return this.executeOp({ op: 'sendPrompt', app: appName, text, requestId, timeoutMs: 6000 });
  }

  async observeResponse(appName, requestId, timeoutMs = 30000) {
    return this.executeOp({ op: 'observeResponse', app: appName, requestId, timeoutMs });
  }

  async sendAndObserve(appName, text, requestId, timeoutMs = 30000, { activate = true } = {}) {
    return this.executeOp({
      op: 'sendAndObserve',
      app: appName,
      text,
      requestId,
      timeoutMs,
      activate
    });
  }

  async ping() {
    return this.executeOp({ op: 'ping' });
  }

  async inspectApp(appName) {
    return this.executeOp({ op: 'inspect', app: appName });
  }

  async inspectElements(appName) {
    return this.executeOp({ op: 'elements', app: appName });
  }

  async activateApp(appName) {
    return this.executeOp({ op: 'activate', app: appName });
  }

  async getFrontmostApp() {
    return this.executeOp({ op: 'frontmost' });
  }

  async restoreFocus(pid) {
    return this.executeOp({ op: 'restoreFocus', pid });
  }

  async unhideApp(appName) {
    return this.executeOp({ op: 'unhide', app: appName });
  }

  async setupObserver(appName) {
    return this.executeOp({ op: 'observe', app: appName });
  }
}
