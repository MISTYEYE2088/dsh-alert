// OS-facing notification for dsh-alert.
//
// This module owns everything that touches the desktop: which command runs, how
// the text is escaped, and what happens when the command is missing or fails.
// It is deliberately dependency-free and fire-and-forget — a missing
// notification tool or a locked-down PowerShell must never disturb an agent run.
//
// One helper process per alert. A toast takes ~250 ms to appear, so the child is
// detached from the run loop immediately and killed after a timeout.
//
// Platform support:
//   win32  PowerShell 5.1 + Windows.UI.Notifications: a real Action Center toast,
//          which carries the system notification sound. Falls back to a system
//          sound when the toast API cannot be used.
//   darwin osascript `display notification`, with the sound named in the script.
//   linux  notify-send, plus paplay for the tone; both are optional.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import process from 'node:process'

// The toast is shown under PowerShell's registered AppUserModelID. Windows only
// renders a toast for an AUMID that a Start-menu shortcut owns, and installing a
// shortcut for a plugin would be far more invasive than borrowing the one that
// already exists on every Windows install.
const WINDOWS_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
const WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const SPAWN_TIMEOUT_MS = 10_000

/** Escape one string for an XML text node. */
function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Render one PowerShell single-quoted literal (an apostrophe doubles). */
function psLiteral(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

/** Render one AppleScript double-quoted literal. */
function appleLiteral(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

// #FUNC Build the PowerShell 5.1 program that shows one toast.
// #NOT  Does not register a Start-menu shortcut for a dedicated AppUserModelID;
//       see WINDOWS_AUMID.
// #EDGE-IN Text containing quotes, ampersands, apostrophes, or angle brackets is
//           escaped for both XML and PowerShell →
//           smoke: windowsScriptEscapesHostileText
// #WHY  `-EncodedCommand` is used instead of a command line because it removes
//       every quoting and escaping layer between Node and Windows: the program
//       arrives as base64 and the command line never contains user text.
export function buildWindowsScript(alert, switches = {}) {
  const sound = switches.sound !== false
  const title = psLiteral(xmlEscape(alert.title ?? ''))
  const body = psLiteral(xmlEscape(alert.body ?? ''))
  const audio = sound
    ? '<audio src="ms-winsoundevent:Notification.Default" />'
    : '<audio silent="true" />'
  return [
    "$ErrorActionPreference = 'Stop'",
    '$title = ' + title,
    '$body = ' + body,
    '$sound = $' + (sound ? 'true' : 'false'),
    '$audio = ' + psLiteral(audio),
    'try {',
    '  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
    '  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]',
    '  [void][Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]',
    '  $xml = [Windows.Data.Xml.Dom.XmlDocument]::new()',
    "  $texts = '<text>' + $title + '</text>'",
    "  if ($body.Length -gt 0) { $texts = $texts + '<text>' + $body + '</text>' }",
    '  $xml.LoadXml(\'<toast duration="short"><visual><binding template="ToastGeneric">\' + $texts + \'</binding></visual>\' + $audio + \'</toast>\')',
    '  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
    '  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(' + psLiteral(WINDOWS_AUMID) + ').Show($toast)',
    '} catch {',
    '  if ($sound) { try { [System.Media.SystemSounds]::Exclamation.Play() } catch { } }',
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    '  exit 1',
    '}',
    'exit 0',
  ].join('\r\n') + '\r\n'
}

// #FUNC Build the AppleScript program that shows one notification.
// #EDGE-IN A quoted or backslash-bearing body is escaped →
//           smoke: osascriptEscapesHostileText
// #WHY  `sound name` belongs in the same script as the notification, so a silent
//       alert cannot leave a stray sound behind.
export function buildOsascript(alert, switches = {}) {
  const sound = switches.sound !== false
  const parts = [
    'display notification ' + appleLiteral(alert.body ?? ''),
    'with title ' + appleLiteral(alert.title ?? ''),
  ]
  if (sound) parts.push('sound name ' + appleLiteral(alert.failed === true ? 'Basso' : 'Glass'))
  return parts.join(' ')
}

/** Encode a program for `powershell.exe -EncodedCommand` (base64 of UTF-16LE). */
export function encodePowerShellCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * Create the OS notifier for this machine.
 *
 * @param {object} [options] - Injection points for tests and for the platform.
 * @param {typeof spawn} [options.spawn] - Child-process factory.
 * @param {string} [options.platform] - `process.platform` override.
 * @param {(message: string) => void} [options.warn] - One-time warning sink.
 * @param {(path: string) => boolean} [options.exists] - Filesystem probe.
 * @returns {{ send: (alert: object, switches?: object) => boolean, platform: string }}
 */
export function createNotifier(options = {}) {
  const launch = options.spawn ?? spawn
  const platform = options.platform ?? process.platform
  const warn = options.warn ?? ((message) => { console.warn('[dsh-alert] ' + message) })
  const exists = options.exists ?? existsSync
  const reported = new Set()

  function reportOnce(key, message) {
    if (reported.has(key)) return
    reported.add(key)
    warn(message)
  }

  // #FUNC Run one detached helper program and forget about it.
  // #NOT  Does not wait for completion or surface stdout; the alert must never
  //       block the session event that triggered it.
  // #WHY  `stdio: 'ignore'` on stdin/stdout and `windowsHide` keep a console
  //       window from flashing on every completed round, while stderr is kept
  //       because a failed toast is otherwise invisible to the user.
  function run(command, args, label) {
    let child
    try {
      child = launch(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    } catch (error) {
      reportOnce(label, 'could not start ' + command + ': ' + String(error))
      return false
    }
    let stderr = ''
    if (child !== null && typeof child === 'object' && child.stderr !== null
      && typeof child.stderr === 'object' && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => {
        if (stderr.length < 2000) stderr += String(chunk)
      })
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch (error) { /* already gone */ }
    }, SPAWN_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    if (child !== null && typeof child === 'object' && typeof child.on === 'function') {
      child.on('error', (error) => {
        clearTimeout(timer)
        reportOnce(label, command + ' failed: ' + String(error))
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        if (typeof code === 'number' && code !== 0) {
          const detail = stderr.trim().length > 0 ? ': ' + stderr.trim().slice(0, 300) : ''
          reportOnce(label + ':exit', command + ' exited with ' + code + detail)
        }
      })
      if (typeof child.unref === 'function') child.unref()
    }
    return true
  }

  function sendWindows(alert, sound, notify) {
    let started = false
    if (notify) {
      const shell = exists(WINDOWS_POWERSHELL) ? WINDOWS_POWERSHELL : 'powershell.exe'
      started = run(shell, [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', encodePowerShellCommand(buildWindowsScript(alert, { sound })),
      ], 'windows-toast')
    }
    if (!started && sound) {
      run('rundll32.exe', ['user32.dll,MessageBeep'], 'windows-beep')
    }
    return started
  }

  function sendMac(alert, sound, notify) {
    if (!notify) return false
    return run('osascript', ['-e', buildOsascript(alert, { sound })], 'mac-notification')
  }

  function sendLinux(alert, sound, notify) {
    let started = false
    if (notify) {
      started = run('notify-send', ['-a', 'DeepSeek Harness', '-t', '8000', alert.title ?? '', alert.body ?? ''], 'linux-notify')
    }
    if (sound) {
      const file = alert.failed === true
        ? '/usr/share/sounds/freedesktop/stereo/dialog-error.oga'
        : '/usr/share/sounds/freedesktop/stereo/complete.oga'
      started = run('paplay', [file], 'linux-sound') || started
    }
    return started
  }

  return {
    platform,
    /**
     * Show one alert. Never throws.
     *
     * @param {{ title: string, body: string, failed?: boolean }} alert - Rendered text.
     * @param {{ sound?: boolean, notify?: boolean }} [switches] - Per-call switches.
     * @returns {boolean} Whether a helper program was started.
     */
    send(alert, switches = {}) {
      if (alert === null || typeof alert !== 'object') return false
      const sound = switches.sound !== false
      const notify = switches.notify !== false
      if (platform === 'win32') return sendWindows(alert, sound, notify)
      if (platform === 'darwin') return sendMac(alert, sound, notify)
      if (platform === 'linux') return sendLinux(alert, sound, notify)
      reportOnce('unsupported-platform', 'no OS notifier for platform ' + platform + '; alerts are log-only')
      return false
    },
  }
}
