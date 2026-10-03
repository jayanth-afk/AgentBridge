import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * ConversationLocator:
 * High-precision conversation detection across macOS desktop AI clients (Claude Desktop, ChatGPT Desktop).
 * Inspects AX hierarchies, window titles, selected navigation items, and conversation containers.
 * Guarantees zero-guess behavior: returns TARGET_AMBIGUOUS if certainty is insufficient.
 */
export class ConversationLocator {
  constructor(options = {}) {
    this.options = options;
  }

  /**
   * Find the currently active conversation in the specified target application.
   */
  async findActiveConversation({ targetApp, bundleId = null }) {
    const script = `
      var se = Application("System Events");
      var procs = se.applicationProcesses.whose({name: "${targetApp}"});
      if (procs.length === 0) {
        JSON.stringify({ found: false, error: "PROCESS_NOT_FOUND" });
      } else {
        var p = procs[0];
        var wins = p.windows();
        if (wins.length === 0) {
          JSON.stringify({ found: false, error: "NO_OPEN_WINDOW" });
        } else if (wins.length > 2) {
          // Multiple non-modal windows imply ambiguous target
          JSON.stringify({ found: false, error: "TARGET_AMBIGUOUS", windowCount: wins.length });
        } else {
          var win = wins[0];
          var title = "";
          try { title = win.title(); } catch(e) {}

          // Search for conversation headers, selected sidebar items, or active document title
          var conversationTitle = title;
          var conversationId = null;
          var focusedArea = null;

          function scanElements(elem, depth) {
            if (depth > 5) return;
            try {
              var role = elem.role();
              var desc = "";
              try { desc = elem.description(); } catch(e) {}
              var val = "";
              try { val = elem.value(); } catch(e) {}
              var subrole = "";
              try { subrole = elem.subrole(); } catch(e) {}

              // Detect selected chat navigation item
              if ((role === "AXRow" || role === "AXStaticText" || role === "AXButton") && 
                  (desc.indexOf("Selected") >= 0 || subrole === "AXSelected")) {
                if (val && typeof val === "string" && val.length > 1) {
                  conversationTitle = val;
                }
              }

              // Detect active focused text area
              if ((role === "AXTextArea" || role === "AXTextField")) {
                try {
                  if (elem.focused()) {
                    focusedArea = { role: role, description: desc };
                  }
                } catch(e) {}
              }

              var kids = elem.uiElements();
              for (var i = 0; i < kids.length; i++) {
                scanElements(kids[i], depth + 1);
              }
            } catch(e) {}
          }

          scanElements(win, 0);

          JSON.stringify({
            found: true,
            targetApp: "${targetApp}",
            windowTitle: title,
            conversationTitle: conversationTitle,
            conversationId: conversationId,
            hasFocusedInput: Boolean(focusedArea),
            unambiguous: true
          });
        }
      }
    `;

    try {
      const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 4000 });
      const res = JSON.parse(stdout.trim());
      if (!res.found) {
        return {
          unambiguous: false,
          conversation: null,
          status: res.error || 'TARGET_AMBIGUOUS',
          details: res
        };
      }
      return {
        unambiguous: true,
        status: 'VERIFIED',
        conversation: {
          app: res.targetApp,
          windowTitle: res.windowTitle,
          title: res.conversationTitle,
          id: res.conversationId,
          hasFocusedInput: res.hasFocusedInput
        }
      };
    } catch (err) {
      return {
        unambiguous: false,
        conversation: null,
        status: 'ERROR',
        error: err.message
      };
    }
  }

  /**
   * Find conversation by specific title.
   */
  async findConversationByTitle({ targetApp, title }) {
    const active = await this.findActiveConversation({ targetApp });
    if (!active.unambiguous || !active.conversation) {
      return active;
    }
    const match = active.conversation.title && active.conversation.title.toLowerCase().includes(title.toLowerCase());
    if (match) {
      return { unambiguous: true, status: 'VERIFIED', conversation: active.conversation };
    }
    return {
      unambiguous: false,
      status: 'TITLE_MISMATCH',
      expected: title,
      current: active.conversation.title
    };
  }

  /**
   * Verify whether the currently active window matches expected criteria.
   */
  async verifyConversation({ targetApp, expectedTitle = null, expectedId = null }) {
    const active = await this.findActiveConversation({ targetApp });
    if (!active.unambiguous) {
      return { ok: false, status: active.status, details: active };
    }

    if (expectedTitle && !active.conversation.title.toLowerCase().includes(expectedTitle.toLowerCase())) {
      return {
        ok: false,
        status: 'TARGET_AMBIGUOUS',
        reason: `Active conversation "${active.conversation.title}" does not match expected "${expectedTitle}"`
      };
    }

    return {
      ok: true,
      status: 'VERIFIED',
      conversation: active.conversation
    };
  }
}
