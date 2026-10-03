#!/usr/bin/env node

/**
 * macOS Accessibility UI Probe
 * Inspects running applications to discover accessibility trees (AXWindow, AXTextArea, AXButton, etc.)
 * Read-only inspection tool for testing and validating UI automation surfaces safely.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function probeApplicationUI(appName) {
  // 1. Check if process is running
  let pids = [];
  try {
    const { stdout } = await execFileAsync('pgrep', ['-i', '-f', appName]);
    pids = stdout.trim().split('\n').filter(Boolean).map(Number);
  } catch {
    pids = [];
  }

  if (pids.length === 0) {
    return {
      application: appName,
      running: false,
      pid: null,
      windows: [],
      inputElements: [],
      buttons: [],
      textRegions: [],
      notes: `${appName} is not currently running.`
    };
  }

  // 2. Query System Events via JXA for non-intrusive Accessibility Tree inspection
  const jxaScript = `
    const se = Application("System Events");
    const procs = se.applicationProcesses.whose({name: "${appName}"});
    if (procs.length === 0) {
      JSON.stringify({ found: false });
    } else {
      const p = procs[0];
      const winList = [];
      const inputList = [];
      const buttonList = [];
      const textList = [];

      try {
        const wins = p.windows();
        for (let i = 0; i < wins.length; i++) {
          const w = wins[i];
          let title = "";
          let subrole = "";
          try { title = w.title(); } catch {}
          try { subrole = w.subrole(); } catch {}
          winList.push({ index: i, title: title || "(untitled)", subrole: subrole || "standard" });

          // Inspect UI elements inside window (depth 3 traversal)
          function scanElement(elem, depth) {
            if (depth > 4) return;
            try {
              const role = elem.role();
              let name = "";
              let desc = "";
              let val = "";
              try { name = elem.name(); } catch {}
              try { desc = elem.description(); } catch {}
              try { val = String(elem.value() || ""); } catch {}

              if (role === "AXTextField" || role === "AXTextArea" || role === "AXSearchField") {
                inputList.push({
                  role,
                  name: name || desc || "(unnamed)",
                  description: desc,
                  hasValue: Boolean(val),
                  valueSnippet: val ? val.slice(0, 50) : null
                });
              } else if (role === "AXButton") {
                if (name || desc) {
                  buttonList.push({
                    role,
                    name: name || desc,
                    title: elem.title ? (() => { try { return elem.title(); } catch { return ""; } })() : ""
                  });
                }
              } else if (role === "AXStaticText") {
                if (val && val.length > 2 && textList.length < 20) {
                  textList.push({
                    role,
                    snippet: val.slice(0, 80)
                  });
                }
              }

              // Recurse children
              const children = elem.uiElements();
              for (let c = 0; c < children.length; c++) {
                scanElement(children[c], depth + 1);
              }
            } catch {}
          }

          scanElement(w, 0);
        }
      } catch (err) {
        // Accessibility permission or window access error
      }

      JSON.stringify({
        found: true,
        windows: winList,
        inputElements: inputList,
        buttons: buttonList.slice(0, 30),
        textRegions: textList.slice(0, 30)
      });
    }
  `;

  try {
    const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', jxaScript], { timeout: 5000 });
    const parsed = JSON.parse(stdout.trim());
    return {
      application: appName,
      running: true,
      pid: pids[0] || null,
      windows: parsed.windows || [],
      inputElements: parsed.inputElements || [],
      buttons: parsed.buttons || [],
      textRegions: parsed.textRegions || [],
      accessibilitySupported: Boolean(parsed.found)
    };
  } catch (err) {
    return {
      application: appName,
      running: true,
      pid: pids[0] || null,
      windows: [],
      inputElements: [],
      buttons: [],
      textRegions: [],
      accessibilitySupported: false,
      error: err.message
    };
  }
}

if (process.argv[1].endsWith('probe.js')) {
  const target = process.argv[2] || 'Claude';
  probeApplicationUI(target).then((res) => {
    console.log(JSON.stringify(res, null, 2));
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
