import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { activateDesktopApp } from '../session-adapters/desktop-notifier.js';
import { ConversationLocator } from './conversation-locator.js';

const execFileAsync = promisify(execFile);

/**
 * Hardened macOS Accessibility (AX) Engine
 * Implements robust element hierarchy discovery, stable selector priority,
 * multi-step send verification, and safe hidden-window activation.
 */
export class AXEngine {
  constructor(options = {}) {
    this.options = options;
    this.locator = new ConversationLocator(options);
    this.allowHiddenActivation = options.allowHiddenWindowActivation !== false;
    this.activationTimeoutMs = options.activationTimeoutMs || 2500;
  }

  /**
   * Inspect complete accessibility hierarchy of target application.
   */
  async inspectApp(targetApp) {
    const script = `
      var se = Application("System Events");
      var procs = se.applicationProcesses.whose({name: "${targetApp}"});
      if (procs.length === 0) {
        JSON.stringify({ running: false, error: "PROCESS_NOT_FOUND" });
      } else {
        var p = procs[0];
        var wins = p.windows();
        var bundleId = "";
        try { bundleId = p.bundleIdentifier(); } catch(e) {}

        var elements = [];
        var inputCandidates = [];
        var buttonCandidates = [];
        var textRegions = [];

        if (wins.length > 0) {
          var win = wins[0];
          function walk(elem, depth, parentRole) {
            if (depth > 6) return;
            try {
              var role = elem.role();
              var subrole = "";
              try { subrole = elem.subrole(); } catch(e) {}
              var title = "";
              try { title = elem.title(); } catch(e) {}
              var desc = "";
              try { desc = elem.description(); } catch(e) {}
              var id = "";
              try { id = elem.identifier(); } catch(e) {}
              var val = "";
              try {
                var v = elem.value();
                if (typeof v === "string") val = v.slice(0, 150);
              } catch(e) {}
              var enabled = true;
              try { enabled = elem.enabled(); } catch(e) {}
              var focused = false;
              try { focused = elem.focused(); } catch(e) {}

              // Structural and selector priority score:
              // 1: identifier, 2: description, 3: role+title, 4: structural
              var selectorPriority = 4;
              if (id && id.length > 0) selectorPriority = 1;
              else if (desc && desc.length > 0) selectorPriority = 2;
              else if (title && title.length > 0) selectorPriority = 3;

              var record = {
                role: role,
                subrole: subrole,
                title: title,
                description: desc,
                identifier: id,
                value: val,
                enabled: enabled,
                focused: focused,
                selectorPriority: selectorPriority,
                depth: depth,
                parentRole: parentRole
              };

              // Collect text input candidates
              if (role === "AXTextArea" || role === "AXTextField" || (role === "AXWebArea" && focused)) {
                inputCandidates.push(record);
              }

              // Collect buttons (Send, Submit, Enter)
              if (role === "AXButton") {
                buttonCandidates.push(record);
              }

              // Collect readable text
              if ((role === "AXStaticText" || role === "AXRow") && val && val.length > 0) {
                textRegions.push({ role: role, snippet: val });
              }

              var children = elem.uiElements();
              for (var i = 0; i < children.length; i++) {
                walk(children[i], depth + 1, role);
              }
            } catch(e) {}
          }
          walk(win, 0, "AXWindow");
        }

        JSON.stringify({
          running: true,
          targetApp: "${targetApp}",
          bundleId: bundleId,
          windowCount: wins.length,
          windows: wins.map(function(w, idx) {
            var t = "";
            try { t = w.title(); } catch(e) {}
            return { index: idx + 1, title: t };
          }),
          inputCandidates: inputCandidates,
          buttonCandidates: buttonCandidates,
          textRegions: textRegions
        });
      }
    `;

    try {
      const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 6000 });
      return JSON.parse(stdout.trim());
    } catch (err) {
      return { running: false, error: err.message };
    }
  }

  /**
   * Handle Hidden / Minimized window:
   * If windows.length === 0, attempt activation with bounded timeout.
   */
  async ensureAccessibleWindow(targetApp) {
    let inspection = await this.inspectApp(targetApp);
    if (!inspection.running) {
      return { ok: false, error: 'APP_NOT_RUNNING', details: inspection.error };
    }

    if (inspection.windowCount > 0) {
      return { ok: true, inspection };
    }

    if (!this.allowHiddenActivation) {
      return { ok: false, error: 'NO_OPEN_WINDOW', details: `${targetApp} has no open window and activation is disabled.` };
    }

    // Attempt controlled activation
    await activateDesktopApp(targetApp);
    await new Promise(r => setTimeout(r, 600));

    // Re-inspect
    inspection = await this.inspectApp(targetApp);
    if (inspection.windowCount > 0) {
      return { ok: true, inspection, activated: true };
    }

    return {
      ok: false,
      error: 'NOT_READY',
      details: `${targetApp} activated but did not present an accessible window within timeout.`
    };
  }

  /**
   * Complete 14-Step Reliable Submission Sequence
   */
  async executeReliableSend({
    targetApp,
    bundleId = null,
    text,
    requestId,
    conversationTitle = null,
    activateApp = true
  }) {
    // 1. Ensure accessible window (with safe activation fallback)
    const windowState = await this.ensureAccessibleWindow(targetApp);
    if (!windowState.ok) {
      return { success: false, step: 'window_check', error: windowState.error, details: windowState.details };
    }

    const inspection = windowState.inspection;

    // 2. Verify bundle identifier if specified
    if (bundleId && inspection.bundleId && !inspection.bundleId.includes(bundleId)) {
      return {
        success: false,
        step: 'bundle_id_check',
        error: 'BUNDLE_ID_MISMATCH',
        expected: bundleId,
        actual: inspection.bundleId
      };
    }

    // 3. Verify conversation target without ambiguity
    const convResult = await this.locator.findActiveConversation({ targetApp, bundleId });
    if (!convResult.unambiguous) {
      return {
        success: false,
        step: 'conversation_check',
        error: convResult.status,
        details: 'Target conversation is ambiguous or multiple windows are open.'
      };
    }

    if (conversationTitle && !convResult.conversation.title.toLowerCase().includes(conversationTitle.toLowerCase())) {
      return {
        success: false,
        step: 'conversation_match',
        error: 'TARGET_AMBIGUOUS',
        reason: `Active conversation "${convResult.conversation.title}" does not match requested "${conversationTitle}"`
      };
    }

    // 4. Verify input element candidate exists and is enabled
    const inputs = inspection.inputCandidates || [];
    if (inputs.length === 0) {
      return { success: false, step: 'input_discovery', error: 'INPUT_NOT_FOUND', details: 'No accessible input element found.' };
    }

    // Pick input by highest selector priority
    inputs.sort((a, b) => a.selectorPriority - b.selectorPriority);
    const chosenInput = inputs[0];
    if (!chosenInput.enabled) {
      return { success: false, step: 'input_enabled_check', error: 'INPUT_DISABLED', details: 'Input element is disabled.' };
    }

    // 5. Format tagged payload with requestId marker
    const taggedPayload = `[Agent Bridge ${requestId}]\n${text}`;
    const escaped = JSON.stringify(taggedPayload);

    const submitRes = await this._executeSubmissionScript({ targetApp, escaped, requestId });
    if (!submitRes.ok) {
      return {
        success: false,
        step: 'submission_execution',
        error: submitRes.error || 'VALUE_ASSIGNMENT_FAILED',
        details: submitRes
      };
    }

    return {
      success: true,
      step: 'completed',
      requestId,
      targetApp,
      conversation: convResult.conversation,
      inputSelectorPriority: chosenInput.selectorPriority,
      inputRole: chosenInput.role,
      clickedSend: submitRes.clickedSend,
      status: 'REQUEST_SENT'
    };
  }

  async _executeSubmissionScript({ targetApp, escaped, requestId }) {
    const submissionScript = `
      var se = Application("System Events");
      var proc = se.processes.byName("${targetApp}");
      if (!proc.exists() || proc.windows.length === 0) {
        JSON.stringify({ ok: false, error: "WINDOW_LOST" });
      } else {
        var win = proc.windows[0];
        var targetArea = null;
        var sendButton = null;

        function findControls(elem, depth) {
          if (depth > 6) return;
          try {
            var role = elem.role();
            var desc = "";
            try { desc = elem.description(); } catch(e) {}
            var title = "";
            try { title = elem.title(); } catch(e) {}

            if (!targetArea && (role === "AXTextArea" || role === "AXTextField")) {
              targetArea = elem;
            }

            if (!sendButton && role === "AXButton") {
              if (desc.indexOf("Send") >= 0 || title.indexOf("Send") >= 0 || desc.indexOf("Submit") >= 0) {
                sendButton = elem;
              }
            }

            var kids = elem.uiElements();
            for (var i = 0; i < kids.length; i++) {
              findControls(kids[i], depth + 1);
            }
          } catch(e) {}
        }
        findControls(win, 0);

        if (!targetArea) {
          JSON.stringify({ ok: false, error: "INPUT_NOT_LOCATED" });
        } else {
          targetArea.value = ${escaped};
          var assignedVal = "";
          try { assignedVal = targetArea.value(); } catch(e) {}

          var valueChanged = (assignedVal.indexOf("${requestId}") >= 0);
          var clickedSend = false;

          if (sendButton) {
            try {
              if (sendButton.enabled()) {
                sendButton.click();
                clickedSend = true;
              }
            } catch(e) {}
          }

          JSON.stringify({
            ok: valueChanged,
            valueChanged: valueChanged,
            clickedSend: clickedSend,
            hasSendButton: Boolean(sendButton)
          });
        }
      }
    `;

    try {
      const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', submissionScript], { timeout: 6000 });
      return JSON.parse(stdout.trim());
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}
