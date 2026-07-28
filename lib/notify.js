'use strict';
// End-of-run notification: the one moment the human is meant to hear from the
// system. Best-effort by design — a failed toast must never fail a run.

const { spawnSync } = require('child_process');

function xmlEscape(s) {
  // XML 1.0 forbids most control characters, and halt messages can embed
  // captured CLI stderr (ANSI escapes included) — strip both or LoadXml throws
  // and the toast silently dies exactly when it matters most.
  return String(s)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

function windowsToast(title, message, url) {
  const launch = url ? ` activationType="protocol" launch="${xmlEscape(url)}"` : '';
  const script = `
$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]
$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime]
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast${launch.replace(/'/g, "''")}><visual><binding template="ToastGeneric"><text>${xmlEscape(title).replace(/'/g, "''")}</text><text>${xmlEscape(message).replace(/'/g, "''")}</text></binding></visual><audio src="ms-winsoundevent:Notification.Default"/></toast>')
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true, timeout: 20000, encoding: 'utf8',
  });
  return r.status === 0;
}

function windowsMsgFallback(title, message) {
  const user = process.env.USERNAME || '*';
  const r = spawnSync('msg', [user, '/time:300', `${title}\n\n${message}`], {
    windowsHide: true, timeout: 10000, encoding: 'utf8',
  });
  return r.status === 0;
}

// Returns the channel that worked ('toast' | 'msg' | 'console' | 'none').
function notify(title, message, url) {
  try {
    if (process.platform === 'win32') {
      if (windowsToast(title, message, url)) return 'toast';
      if (windowsMsgFallback(title, message)) return 'msg';
    }
  } catch { /* fall through */ }
  try {
    console.log(`\n${'*'.repeat(60)}\n${title}\n${message}${url ? `\n${url}` : ''}\n${'*'.repeat(60)}\n`);
    return 'console';
  } catch {
    return 'none';
  }
}

module.exports = { notify, xmlEscape };
