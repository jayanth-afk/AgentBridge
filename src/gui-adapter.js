import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * GUI Automation Adapter (OPTIONAL)
 * 
 * NOTE: This is NOT native agent-to-agent communication.
 * This is an optional, experimental macOS UI bridge that utilizes AppleScript /
 * System Events to inspect or mediate with desktop application windows.
 * 
 * Limitations & Constraints:
 * 1. Requires macOS Accessibility authorization in System Settings > Privacy & Security > Accessibility.
 * 2. If the calling process lacks Accessibility privileges, macOS raises error -1728 (fail-closed).
 * 3. Does not modify application state or keystrokes without explicit human guidance.
 */
export class GuiAutomationAdapter {
  constructor() {
    this.name = 'GUI automation adapter';
  }

  async checkAccessibilityPermission() {
    try {
      const script = `tell application "System Events" to get name of first process whose frontmost is true`;
      const { stdout } = await execAsync(`osascript -e '${script}'`);
      return {
        hasPermission: true,
        frontmostProcess: stdout.trim(),
        message: 'macOS Accessibility permission is active.'
      };
    } catch (err) {
      const isNotAllowed = err.message.includes('-1728') || err.message.includes('not allowed assistive access');
      return {
        hasPermission: false,
        error: isNotAllowed ? 'Assistive access not granted (-1728)' : err.message,
        message: 'Antigravity IDE / Node has not been granted macOS Accessibility privileges in System Settings.'
      };
    }
  }

  async getRunningAgentWindows() {
    const perm = await this.checkAccessibilityPermission();
    if (!perm.hasPermission) {
      return {
        status: 'unavailable',
        reason: perm.message,
        details: perm.error
      };
    }

    try {
      const script = `
        tell application "System Events"
          set chatgptRunning to (count of (processes whose name is "ChatGPT")) > 0
          set claudeRunning to (count of (processes whose name is "Claude")) > 0
          return "chatgpt:" & chatgptRunning & ",claude:" & claudeRunning
        end tell
      `;
      const { stdout } = await execAsync(`osascript -e '${script}'`);
      return {
        status: 'available',
        runningInfo: stdout.trim()
      };
    } catch (err) {
      return {
        status: 'error',
        error: err.message
      };
    }
  }

  async getClipboardContent() {
    try {
      const { stdout } = await execAsync('pbpaste');
      return { success: true, text: stdout };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async setClipboardContent(text) {
    try {
      const proc = exec('pbcopy');
      proc.stdin.write(text);
      proc.stdin.end();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}
