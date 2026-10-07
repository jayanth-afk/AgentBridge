import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATE_PATH = path.resolve(MODULE_DIR, '../../data/zia-background-gpt-target.json');

/**
 * Persistent, fail-closed target resolver for ZiA Background GPT.
 *
 * We intentionally persist only UI identity/fingerprints:
 * - project title
 * - dedicated conversation title
 * - stable bootstrap anchor text
 *
 * No cookies, tokens, credentials, or browser storage are touched.
 */
export class ZiABackgroundGPTTarget {
  constructor(options = {}) {
    this.swiftBridge = options.swiftBridge;
    this.projectTitle = options.projectTitle || 'ZiA Response';
    this.statePath = options.statePath || DEFAULT_STATE_PATH;
    this.state = this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.statePath)) return null;
      const value = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      if (!value || value.version !== 1 || !value.projectTitle || !value.conversationTitle) return null;
      return value;
    } catch {
      return null;
    }
  }

  save(state) {
    const dir = path.dirname(this.statePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.statePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.statePath);
    this.state = state;
    return state;
  }

  async inspect() {
    const result = await this.swiftBridge.inspectElements('ChatGPT');
    return result?.ok ? result : { ok: false, error: result?.error || 'CHATGPT_AX_INSPECTION_FAILED' };
  }

  async resolvePersisted() {
    this.state = this.load() || this.state;
    if (!this.state) {
      return { ok: false, status: 'BACKGROUND_TARGET_UNINITIALIZED', error: 'No persisted ZiA Background GPT conversation target exists' };
    }

    const now = Date.now();
    if (this._verifiedAt && (now - this._verifiedAt < 3000) && this._verifiedResult) {
      return this._verifiedResult;
    }

    const inspected = await this.inspect();
    if (!inspected.ok) {
      this._verifiedAt = 0;
      this._verifiedResult = null;
      return { ok: false, status: 'BACKGROUND_TARGET_INSPECTION_FAILED', error: inspected.error };
    }

    const elements = inspected.elements || [];
    const project = elements.find(e => e.role === 'AXButton' && e.title === this.projectTitle);
    if (!project) {
      this._verifiedAt = 0;
      this._verifiedResult = null;
      return { ok: false, status: 'BACKGROUND_PROJECT_NOT_FOUND', error: `Project ${this.projectTitle} was not found in ChatGPT` };
    }

    // ChatGPT exposes the same conversation title in multiple AX locations.
    // The actual project sidebar conversation entry is nested immediately
    // beneath the project group (depth 26 in the current AX tree). A shallower
    // duplicate is a separate navigation/header representation, not a safe
    // navigation target. Keep this exact structural identity fail-closed.
    const matches = elements.filter(e =>
      e.role === 'AXButton' &&
      e.title === this.state.conversationTitle &&
      Number(e.depth) === 26
    );
    if (matches.length !== 1) {
      this._verifiedAt = 0;
      this._verifiedResult = null;
      return {
        ok: false,
        status: matches.length === 0 ? 'BACKGROUND_TARGET_NOT_FOUND' : 'BACKGROUND_TARGET_AMBIGUOUS',
        error: matches.length === 0
          ? `Dedicated conversation ${this.state.conversationTitle} was not found`
          : `Dedicated conversation ${this.state.conversationTitle} is ambiguous`,
        matchCount: matches.length
      };
    }

    const currentWebArea = elements.find(e => e.role === 'AXWebArea');
    const alreadySelected = currentWebArea?.title === this.state.conversationTitle;

    let selectedElements;
    if (!alreadySelected) {
      const pressed = await this.swiftBridge.pressChatGPTButton(this.state.conversationTitle);
      if (!pressed?.ok) {
        this._verifiedAt = 0;
        this._verifiedResult = null;
        return { ok: false, status: 'BACKGROUND_TARGET_SELECT_FAILED', error: pressed?.error || pressed?.status };
      }
      await new Promise(resolve => setTimeout(resolve, 300));
      const selected = await this.inspect();
      if (!selected.ok) {
        this._verifiedAt = 0;
        this._verifiedResult = null;
        return { ok: false, status: 'BACKGROUND_TARGET_VERIFY_FAILED', error: selected.error };
      }
      selectedElements = selected.elements || [];
    } else {
      selectedElements = elements;
    }

    const webArea = selectedElements.find(e => e.role === 'AXWebArea');
    const projectVisible = selectedElements.some(e => e.role === 'AXHeading' && e.title === this.projectTitle)
      || selectedElements.some(e => e.role === 'AXStaticText' && e.value === this.projectTitle);
    const anchorPresent = this.state.anchorText
      ? selectedElements.some(e => typeof e.value === 'string' && e.value.includes(this.state.anchorText))
      : true;

    if (!projectVisible || !webArea) {
      this._verifiedAt = 0;
      this._verifiedResult = null;
      return { ok: false, status: 'BACKGROUND_TARGET_PROJECT_VERIFY_FAILED', error: 'Selected conversation is not visibly inside the ZiA Response project' };
    }
    if (!anchorPresent) {
      this._verifiedAt = 0;
      this._verifiedResult = null;
      return { ok: false, status: 'BACKGROUND_TARGET_ANCHOR_VERIFY_FAILED', error: 'Dedicated conversation anchor was not observed after selection' };
    }

    const result = {
      ok: true,
      status: 'BACKGROUND_TARGET_READY',
      projectTitle: this.projectTitle,
      conversationTitle: this.state.conversationTitle,
      anchorText: this.state.anchorText || null
    };
    this._verifiedAt = Date.now();
    this._verifiedResult = result;
    return result;
  }

  async adoptVerifiedCurrentConversation({ conversationTitle, anchorText }) {
    if (!conversationTitle || !anchorText) {
      return { ok: false, status: 'INVALID_TARGET_IDENTITY' };
    }
    const inspected = await this.inspect();
    if (!inspected.ok) return { ok: false, status: 'BACKGROUND_TARGET_INSPECTION_FAILED', error: inspected.error };
    const elements = inspected.elements || [];
    const webArea = elements.find(e => e.role === 'AXWebArea');
    const projectVisible = elements.some(e => e.role === 'AXButton' && e.title === this.projectTitle)
      && elements.some(e => e.role === 'AXStaticText' && e.value === this.projectTitle);
    const conversationButton = elements.filter(e =>
      e.role === 'AXButton' && e.title === conversationTitle && Number(e.depth) === 26
    );
    const anchorPresent = elements.some(e => typeof e.value === 'string' && e.value.includes(anchorText));

    if (!projectVisible || !webArea || conversationButton.length !== 1 || !anchorPresent) {
      return { ok: false, status: 'BACKGROUND_TARGET_NOT_VERIFIED' };
    }

    const state = this.save({
      version: 1,
      projectTitle: this.projectTitle,
      conversationTitle,
      anchorText,
      savedAt: new Date().toISOString()
    });
    return { ok: true, status: 'BACKGROUND_TARGET_PERSISTED', state };
  }

  hasTarget() {
    return Boolean(this.state?.conversationTitle);
  }
}
