import { execFile } from 'node:child_process';

/**
 * Standard macOS notification and app activation helper for desktop agents.
 * Operates purely via supported macOS system services (AppleScript display notification
 * and tell application activate) without injecting into memory, bypassing permissions,
 * or compromising system security.
 */

export function sendDesktopNotification({ title = 'Agent Bridge', subtitle = '', message = '', sound = true }) {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  return new Promise((resolve) => {
    // Strip quotes, backslashes and line breaks so input cannot break out of
    // the string literal or add a second AppleScript statement.
    const strip = (s) => String(s || '').replace(/["\\\r\n]/g, ' ');
    const cleanMsg = strip(message).slice(0, 200);
    const cleanTitle = strip(title || 'Agent Bridge').slice(0, 100);
    const cleanSub = strip(subtitle).slice(0, 100);
    const soundClause = sound ? ' sound name "Subtle"' : '';
    const script = `display notification "${cleanMsg}" with title "${cleanTitle}" subtitle "${cleanSub}"${soundClause}`;

    try {
      execFile('osascript', ['-e', script], { timeout: 3000 }, (err) => {
        resolve(!err);
      });
    } catch {
      resolve(false);
    }
  });
}

export function activateDesktopApp(appName) {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  return new Promise((resolve) => {
    const cleanName = String(appName || '').replace(/["\\\r\n]/g, '');
    const script = `tell application "${cleanName}" to activate`;

    try {
      execFile('osascript', ['-e', script], { timeout: 3000 }, (err) => {
        resolve(!err);
      });
    } catch {
      resolve(false);
    }
  });
}
