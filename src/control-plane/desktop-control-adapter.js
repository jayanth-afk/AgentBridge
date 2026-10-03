/**
 * Adapter Health Status Constants
 */
export const AdapterHealth = Object.freeze({
  SUPPORTED: 'SUPPORTED',
  AVAILABLE: 'AVAILABLE',
  BLOCKED: 'BLOCKED',
  AMBIGUOUS: 'AMBIGUOUS',
  UNSUPPORTED: 'UNSUPPORTED'
});

/**
 * Standard DesktopControlAdapter Contract
 * All desktop integration transports (MCP, AX, CDP, Browser, Notification)
 * must implement this common contract.
 */
export class DesktopControlAdapter {
  constructor(name, options = {}) {
    this.name = name;
    this.options = options;
    this.connected = false;
  }

  async discover() {
    return { name: this.name, available: false };
  }

  async isInstalled() {
    return false;
  }

  async isRunning() {
    return false;
  }

  async isAccessible() {
    return false;
  }

  async isVisible() {
    return false;
  }

  async isIdle() {
    return true;
  }

  async isBusy() {
    return !(await this.isIdle());
  }

  async activate() {
    return { success: false, error: 'NOT_IMPLEMENTED' };
  }

  async findConversation(criteria = {}) {
    return { unambiguous: false, conversation: null, status: 'TARGET_AMBIGUOUS' };
  }

  async verifyTarget(criteria = {}) {
    return { ok: false, error: 'NOT_IMPLEMENTED' };
  }

  async sendMessage(envelope, options = {}) {
    throw new Error(`${this.name}.sendMessage must be implemented by subclass.`);
  }

  async waitForResponse(requestId, options = {}) {
    throw new Error(`${this.name}.waitForResponse must be implemented by subclass.`);
  }

  async readResponse(requestId, options = {}) {
    return { status: 'unavailable' };
  }

  async cancel(requestId) {
    return { success: false, requestId };
  }

  async recover() {
    return { recovered: [] };
  }

  capabilities() {
    return {
      name: this.name,
      transport: 'unknown',
      canWake: false,
      idleModelWake: false,
      streamingSupported: false
    };
  }

  async health() {
    return {
      status: AdapterHealth.UNSUPPORTED,
      name: this.name,
      details: 'Base adapter'
    };
  }
}
