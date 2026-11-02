// Smoke checks for dsh-alert.
//
// Part A runs the Host half (index.js + notifier.js) against a fake Cordis
// context and a recording notifier: it proves which session events raise an
// alert, what the text says, and that the platform commands are built safely.
//
// Part B runs the real client.js inside a hand-built browser shell: it proves the
// tab-title mark counts rounds and never touches notifications or audio.
//
// Neither part proves that your desktop shows the toast. `tools/probe-os.mjs`
// does that, and is run on purpose rather than on every test run.
//
//   node tools/smoke.mjs
//
// Exit code 0 means every scenario passed.

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { applyWith, describeSessionEvent } from '../index.js'
import { buildOsascript, buildWindowsScript, createNotifier, encodePowerShellCommand } from '../notifier.js'

const CLIENT = fileURLToPath(new URL('../client.js', import.meta.url))

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

let failures = 0
const results = []

function check(scenario, condition, detail) {
  if (condition) return
  failures += 1
  throw new Error(scenario + ': ' + detail)
}

// ---------------------------------------------------------------------------
// Part A: Host half
// ---------------------------------------------------------------------------

function createHostContext() {
  const listeners = new Map()
  const effects = []
  const logs = []
  return {
    ctx: {
      on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, new Set())
        listeners.get(event).add(handler)
        return () => { listeners.get(event).delete(handler) }
      },
      effect(factory) {
        const cleanup = factory()
        effects.push(cleanup)
        return cleanup
      },
      get() {
        return undefined
      },
    },
    emit(event, ...args) {
      const handlers = listeners.get(event)
      if (handlers !== undefined) for (const handler of [...handlers]) handler(...args)
    },
    logs,
    disposeAll() {
      for (const cleanup of effects) if (typeof cleanup === 'function') cleanup()
    },
  }
}

function createSink() {
  const sent = []
  return {
    sent,
    send(alert, switches) {
      sent.push({ alert, switches })
      return true
    },
  }
}

function mainSession(extra = {}) {
  return { id: 'session-main-0001', header: { id: 'session-main-0001', cwd: 'C:\\work\\demo', ...extra } }
}

function turnEnd(turn, reason) {
  return { type: 'turn/end', seq: 7, time: 1_700_000_000_000, data: { turn, reason } }
}

function compactionEnd(extra = {}) {
  return {
    type: 'compaction/end',
    seq: 9,
    time: 1_700_000_000_000,
    data: { compactionId: 'c1', turn: null, ...extra },
  }
}

function hosted(config, sink) {
  const host = createHostContext()
  applyWith(host.ctx, config, {
    notifier: sink,
    log: () => {},
    warn: () => {},
  })
  return host
}

const scenarios = []
function scenario(name, run) {
  scenarios.push({ name, run })
}

scenario('hostRoundCompleteAlerts', async () => {
  const sink = createSink()
  const host = hosted(undefined, sink)
  host.emit('session/event', mainSession(), turnEnd(3, { kind: 'completed' }))
  check('hostRoundCompleteAlerts', sink.sent.length === 1, 'expected 1 alert, got ' + sink.sent.length)
  const { alert } = sink.sent[0]
  check('hostRoundCompleteAlerts', alert.failed === false, 'a completed round was reported as failed')
  check('hostRoundCompleteAlerts', alert.title === 'DSH · Round complete', 'unexpected title ' + alert.title)
  check('hostRoundCompleteAlerts', alert.body === 'demo · turn 3', 'unexpected body ' + alert.body)
})

scenario('hostSubagentIgnored', async () => {
  const sink = createSink()
  const host = hosted(undefined, sink)
  host.emit('session/event', { id: 'session-agent-0002', header: { id: 'session-agent-0002', origin: 'subagent', cwd: 'C:\\work\\demo' } }, turnEnd(1, { kind: 'completed' }))
  check('hostSubagentIgnored', sink.sent.length === 0, 'a subagent round alerted')
})

scenario('hostErrorAlertsWithMessage', async () => {
  const sink = createSink()
  const host = hosted(undefined, sink)
  host.emit('session/event', mainSession(), turnEnd(2, { kind: 'error', error: { message: 'provider returned 500', code: 'HTTP_500' } }))
  check('hostErrorAlertsWithMessage', sink.sent.length === 1, 'expected 1 alert')
  const { alert } = sink.sent[0]
  check('hostErrorAlertsWithMessage', alert.failed === true, 'the failure was not marked')
  check('hostErrorAlertsWithMessage', alert.title === 'DSH · Round failed', 'unexpected title ' + alert.title)
  check('hostErrorAlertsWithMessage', alert.body.includes('provider returned 500'), 'the error text is missing: ' + alert.body)
})

scenario('hostAbortedSilentByDefault', async () => {
  const sink = createSink()
  const host = hosted(undefined, sink)
  host.emit('session/event', mainSession(), turnEnd(4, { kind: 'aborted', reason: { kind: 'user' } }))
  check('hostAbortedSilentByDefault', sink.sent.length === 0, 'a cancelled round alerted')
})

scenario('hostAbortedWhenEnabled', async () => {
  const sink = createSink()
  const host = hosted({ alertOnAborted: true }, sink)
  host.emit('session/event', mainSession(), turnEnd(4, { kind: 'aborted', reason: { kind: 'user' } }))
  check('hostAbortedWhenEnabled', sink.sent.length === 1, 'alertOnAborted did not opt in')
  check('hostAbortedWhenEnabled', sink.sent[0].alert.title === 'DSH · Round cancelled',
    'unexpected title ' + sink.sent[0].alert.title)
})

scenario('hostBookkeepingReasonsSilent', async () => {
  const sink = createSink()
  const host = hosted(undefined, sink)
  for (const kind of ['interrupted', 'forked', 'blocked']) {
    host.emit('session/event', mainSession(), turnEnd(5, { kind }))
  }
  check('hostBookkeepingReasonsSilent', sink.sent.length === 0,
    'a bookkeeping reason alerted: ' + JSON.stringify(sink.sent.map(entry => entry.alert.title)))
})

scenario('hostCompactionAlerts', async () => {
  const sink = createSink()
  const host = hosted(undefined, sink)
  host.emit('session/event', mainSession(), compactionEnd())
  check('hostCompactionAlerts', sink.sent.length === 1, 'expected one compaction alert')
  check('hostCompactionAlerts', sink.sent[0].alert.title === 'DSH · Context compacted',
    'unexpected title ' + sink.sent[0].alert.title)
})

scenario('hostCompactionFailureShowsError', async () => {
  const sink = createSink()
  const host = hosted(undefined, sink)
  host.emit('session/event', mainSession(), compactionEnd({ error: 'summary record rejected' }))
  check('hostCompactionFailureShowsError', sink.sent[0].alert.failed === true, 'the failure was not marked')
  check('hostCompactionFailureShowsError', sink.sent[0].alert.body.includes('summary record rejected'),
    'the error text is missing: ' + sink.sent[0].alert.body)
})

scenario('hostCompactionCanBeDisabled', async () => {
  const sink = createSink()
  const host = hosted({ alertOnCompaction: false }, sink)
  host.emit('session/event', mainSession(), compactionEnd())
  check('hostCompactionCanBeDisabled', sink.sent.length === 0, 'compaction alerted while disabled')
})

scenario('hostDuplicateEventAlertsOnce', async () => {
  const sink = createSink()
  const host = hosted(undefined, sink)
  const event = turnEnd(6, { kind: 'completed' })
  host.emit('session/event', mainSession(), event)
  host.emit('session/event', mainSession(), event)
  check('hostDuplicateEventAlertsOnce', sink.sent.length === 1,
    'the same committed event alerted twice, got ' + sink.sent.length)
})

scenario('hostDisabledSendsNothing', async () => {
  const sink = createSink()
  const host = hosted({ enabled: false }, sink)
  host.emit('session/event', mainSession(), turnEnd(1, { kind: 'completed' }))
  check('hostDisabledSendsNothing', sink.sent.length === 0, 'a disabled plugin alerted')
})

scenario('hostSwitchesReachTheNotifier', async () => {
  const sink = createSink()
  const host = hosted({ notify: false, sound: true }, sink)
  host.emit('session/event', mainSession(), turnEnd(1, { kind: 'completed' }))
  check('hostSwitchesReachTheNotifier', sink.sent[0].switches.notify === false, 'notify: false was not forwarded')
  check('hostSwitchesReachTheNotifier', sink.sent[0].switches.sound === true, 'sound: true was not forwarded')
})

scenario('hostTeardownUnsubscribes', async () => {
  const sink = createSink()
  const host = hosted(undefined, sink)
  host.disposeAll()
  host.emit('session/event', mainSession(), turnEnd(1, { kind: 'completed' }))
  check('hostTeardownUnsubscribes', sink.sent.length === 0, 'an event still alerted after teardown')
})

scenario('hostLabelFallsBackToSessionId', async () => {
  const alert = describeSessionEvent({ id: 'abcdef0123456789', header: {} }, turnEnd(1, { kind: 'completed' }))
  check('hostLabelFallsBackToSessionId', alert.body.startsWith('session abcdef01 · turn 1'),
    'unexpected body ' + alert.body)
})

// --- notifier command construction -----------------------------------------

scenario('windowsScriptEscapesHostileText', async () => {
  const script = buildWindowsScript({ title: "A & B <'x'>", body: 'say "hi" & <bye>' }, { sound: true })
  check('windowsScriptEscapesHostileText', script.includes('A &amp; B &lt;&apos;x&apos;&gt;'),
    'the title was not XML-escaped:\n' + script)
  check('windowsScriptEscapesHostileText', script.includes('say &quot;hi&quot; &amp; &lt;bye&gt;'),
    'the body was not XML-escaped:\n' + script)
  check('windowsScriptEscapesHostileText', script.includes('Windows.UI.Notifications.ToastNotificationManager'),
    'the toast API is missing')
  check('windowsScriptEscapesHostileText', !script.includes("'x'"), 'an unescaped PowerShell quote survived')
})

scenario('windowsScriptSoundSwitch', async () => {
  const loud = buildWindowsScript({ title: 't', body: 'b' }, { sound: true })
  const quiet = buildWindowsScript({ title: 't', body: 'b' }, { sound: false })
  check('windowsScriptSoundSwitch', loud.includes('ms-winsoundevent:Notification.Default'), 'the loud script has no audio')
  check('windowsScriptSoundSwitch', quiet.includes('<audio silent="true" />'), 'the quiet script is not silent')
  check('windowsScriptSoundSwitch', quiet.includes('$sound = $false'), 'the quiet script still uses SoundPlayer')
})

scenario('osascriptEscapesHostileText', async () => {
  const script = buildOsascript({ title: 'A "B"', body: 'C \\ D', failed: true }, { sound: true })
  check('osascriptEscapesHostileText', script.includes('"A \\"B\\""'), 'the title was not escaped: ' + script)
  check('osascriptEscapesHostileText', script.includes('"C \\\\ D"'), 'the body was not escaped: ' + script)
  check('osascriptEscapesHostileText', script.includes('sound name "Basso"'), 'a failed round used the wrong sound')
})

scenario('notifierRunsPowerShellOnWindows', async () => {
  const calls = []
  const notifier = createNotifier({
    platform: 'win32',
    warn: () => {},
    exists: () => true,
    spawn: (command, args) => {
      calls.push({ command, args })
      return { on() {}, kill() {}, unref() {} }
    },
  })
  notifier.send({ title: 'DSH · Round complete', body: 'demo · turn 1' })
  check('notifierRunsPowerShellOnWindows', calls.length === 1, 'expected one spawn, got ' + calls.length)
  check('notifierRunsPowerShellOnWindows', /powershell\.exe$/i.test(calls[0].command), 'wrong command ' + calls[0].command)
  const encoded = calls[0].args[calls[0].args.indexOf('-EncodedCommand') + 1]
  const script = Buffer.from(encoded, 'base64').toString('utf16le')
  check('notifierRunsPowerShellOnWindows', script.includes('DSH · Round complete'),
    'the title did not survive the encoding:\n' + script)
  check('notifierRunsPowerShellOnWindows', calls[0].args.includes('-NonInteractive'), 'the shell could block on input')
})

scenario('notifierReportsUnsupportedPlatformOnce', async () => {
  const warnings = []
  const notifier = createNotifier({ platform: 'freebsd', warn: message => warnings.push(message) })
  const first = notifier.send({ title: 'a', body: 'b' })
  notifier.send({ title: 'a', body: 'b' })
  check('notifierReportsUnsupportedPlatformOnce', first === false, 'an unsupported platform claimed success')
  check('notifierReportsUnsupportedPlatformOnce', warnings.length === 1,
    'expected exactly one warning, got ' + warnings.length)
})

scenario('notifierSurvivesSpawnFailure', async () => {
  const warnings = []
  const notifier = createNotifier({
    platform: 'linux',
    warn: message => warnings.push(message),
    spawn: () => { throw new Error('ENOENT') },
  })
  const started = notifier.send({ title: 'a', body: 'b' }, { sound: false })
  check('notifierSurvivesSpawnFailure', started === false, 'a failed spawn claimed success')
  check('notifierSurvivesSpawnFailure', warnings.length >= 1, 'a failed spawn was silent')
})

scenario('encodedCommandIsUtf16Base64', async () => {
  const encoded = encodePowerShellCommand('Write-Output "ok"')
  check('encodedCommandIsUtf16Base64', Buffer.from(encoded, 'base64').toString('utf16le') === 'Write-Output "ok"',
    'the encoding round trip failed')
})

// ---------------------------------------------------------------------------
// Part B: browser half
// ---------------------------------------------------------------------------

const clientSource = await readFile(CLIENT, 'utf8')

function createBrowserHarness(options = {}) {
  const config = { hidden: false, ...options }
  const documentHandlers = new Map()
  const windowHandlers = new Map()
  const registrations = []
  const consoleLines = []
  let title = 'DSH'
  let hidden = config.hidden

  const document = {
    get title() { return title },
    set title(value) { title = value },
    get hidden() { return hidden },
    addEventListener(type, handler) {
      if (!documentHandlers.has(type)) documentHandlers.set(type, new Set())
      documentHandlers.get(type).add(handler)
    },
    removeEventListener(type, handler) {
      const set = documentHandlers.get(type)
      if (set !== undefined) set.delete(handler)
    },
  }

  const window = {
    __ModuleLoader__: { load(registration) { registrations.push(registration) } },
    addEventListener(type, handler) {
      if (!windowHandlers.has(type)) windowHandlers.set(type, new Set())
      windowHandlers.get(type).add(handler)
    },
    removeEventListener(type, handler) {
      const set = windowHandlers.get(type)
      if (set !== undefined) set.delete(handler)
    },
  }

  const quietConsole = {
    info: (...args) => consoleLines.push({ level: 'info', args }),
    warn: (...args) => consoleLines.push({ level: 'warn', args }),
    error: (...args) => consoleLines.push({ level: 'error', args }),
  }

  const listeners = new Map()
  const effects = []
  const ctx = {
    remote: {
      $on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, new Set())
        listeners.get(event).add(handler)
        return () => { listeners.get(event).delete(handler) }
      },
    },
    on() { return () => {} },
    effect(factory) {
      const cleanup = factory()
      effects.push(cleanup)
      return cleanup
    },
  }

  function emit(event, ...args) {
    const handlers = listeners.get(event)
    if (handlers !== undefined) for (const handler of [...handlers]) handler(...args)
  }

  function setHidden(next) {
    hidden = next
    const handlers = documentHandlers.get('visibilitychange')
    if (handlers !== undefined) for (const handler of [...handlers]) handler({ type: 'visibilitychange' })
  }

  function load() {
    const evaluate = new Function('window', 'document', 'console', clientSource)
    evaluate(window, document, quietConsole)
    check('registration', registrations.length === 1, 'expected one client registration, got ' + registrations.length)
    const registration = registrations[0]
    check('registration', registration.id === 'dsh-alert', 'module id is ' + String(registration.id))
    const module = registration.factory(() => { throw new Error('unexpected require') })
    check('registration', typeof module.apply === 'function', 'apply is not exported')
    check('registration', Array.isArray(module.inject) && module.inject.includes('remote'),
      'inject must contain remote; got ' + JSON.stringify(module.inject))
    check('registration', !module.inject.includes('remote.session'),
      'the title-mark half must not inject remote.session')
    module.apply(ctx)
    return module
  }

  return {
    get title() { return title },
    consoleLines,
    setHidden,
    load,
    emit,
    disposeAll() { for (const cleanup of effects) if (typeof cleanup === 'function') cleanup() },
    get api() { return window.dshAlert },
  }
}

scenario('titleMarkOnlyWhenHidden', async () => {
  const browser = createBrowserHarness({ hidden: false })
  browser.load()
  browser.emit('api-session/added', { sessionId: 's1', cwd: 'C:\\work\\demo' })
  browser.emit('api-session/status', 's1', true)
  browser.emit('api-session/status', 's1', false)
  check('titleMarkOnlyWhenHidden', browser.title === 'DSH', 'a visible tab was marked: ' + browser.title)

  browser.setHidden(true)
  browser.emit('api-session/status', 's1', true)
  browser.emit('api-session/status', 's1', false)
  check('titleMarkOnlyWhenHidden', browser.title === '(1) DSH', 'a hidden tab was not marked: ' + browser.title)
})

scenario('twoUnreadRoundsKeepOnePrefix', async () => {
  const browser = createBrowserHarness({ hidden: true })
  browser.load()
  browser.emit('api-session/added', { sessionId: 's1', cwd: 'C:\\work\\demo' })
  browser.emit('api-session/status', 's1', true)
  browser.emit('api-session/status', 's1', false)
  browser.emit('api-session/status', 's1', true)
  browser.emit('api-session/status', 's1', false)
  check('twoUnreadRoundsKeepOnePrefix', browser.title === '(2) DSH', 'title was not a counted prefix: ' + browser.title)
  browser.setHidden(false)
  check('twoUnreadRoundsKeepOnePrefix', browser.title === 'DSH', 'the mark was not cleared on return: ' + browser.title)
})

scenario('subagentSessionDoesNotMark', async () => {
  const browser = createBrowserHarness({ hidden: true })
  browser.load()
  browser.emit('api-session/added', { sessionId: 's2', origin: 'subagent', cwd: 'C:\\work\\demo' })
  browser.emit('api-session/status', 's2', true)
  browser.emit('api-session/status', 's2', false)
  check('subagentSessionDoesNotMark', browser.title === 'DSH', 'a subagent round marked the tab: ' + browser.title)
})

scenario('unknownSessionIsReportedNotMarked', async () => {
  const browser = createBrowserHarness({ hidden: true })
  browser.load()
  browser.emit('api-session/status', 's3', true)
  browser.emit('api-session/status', 's3', false)
  check('unknownSessionIsReportedNotMarked', browser.title === 'DSH', 'an unidentified session marked the tab')
  const warned = browser.consoleLines.some(line => line.level === 'warn' && String(line.args[1]).includes('never announced'))
  check('unknownSessionIsReportedNotMarked', warned, 'an unidentified session was dropped silently')
})

scenario('baselineStatusDoesNotMark', async () => {
  const browser = createBrowserHarness({ hidden: true })
  browser.load()
  browser.emit('api-session/added', { sessionId: 's4', cwd: 'C:\\work\\demo' })
  browser.emit('api-session/status', 's4', false)
  check('baselineStatusDoesNotMark', browser.title === 'DSH', 'the first status of a session marked the tab')
})

scenario('clientTeardownUnsubscribes', async () => {
  const browser = createBrowserHarness({ hidden: true })
  browser.load()
  browser.emit('api-session/added', { sessionId: 's5', cwd: 'C:\\work\\demo' })
  browser.disposeAll()
  browser.emit('api-session/status', 's5', true)
  browser.emit('api-session/status', 's5', false)
  check('clientTeardownUnsubscribes', browser.title === 'DSH', 'an event still marked the tab after teardown')
})

// ---------------------------------------------------------------------------

for (const { name, run } of scenarios) {
  try {
    await run()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error: error.message })
  }
}

const failed = results.filter(result => !result.ok)
for (const result of results) {
  if (result.ok) console.log('ok   ' + result.name)
  else console.log('FAIL ' + result.name + '\n       ' + result.error.replace(/\n/g, '\n       '))
}
console.log('')
console.log(results.length - failed.length + '/' + results.length + ' scenarios passed')
process.exit(failed.length === 0 ? 0 : 1)
