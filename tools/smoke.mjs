// Smoke checks for the dsh-alert browser half.
//
// These run the real client.js — the same bytes the Host serves — inside a
// hand-built browser and Cordis shell, then drive the Host events the plugin
// listens to and count the alerts it produced. They are not a browser: they
// cannot prove that Chrome lets a hidden tab post a notification or play a
// tone. What they do prove is the part that used to break silently — which
// event produces an alert, and how many alerts one round produces across a
// replay, a refresh, and a resume.
//
//   node tools/smoke.mjs
//
// Exit code 0 means every scenario passed.

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../client.js', import.meta.url))
const source = await readFile(CLIENT, 'utf8')

let failures = 0
const results = []

function check(scenario, condition, detail) {
  if (condition) return
  failures += 1
  throw new Error(scenario + ': ' + detail)
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const settle = () => new Promise(resolve => setTimeout(resolve, 25))

// A queue-backed async iterable, which is what session.follow() hands the
// `for await` loop. Aborting the signal ends the iteration like a closed
// transport does.
function createStream() {
  const queue = []
  let waiting = null
  let closed = false
  const stream = {
    push(frame) {
      if (closed) return
      if (waiting !== null) {
        const resolve = waiting
        waiting = null
        resolve({ value: frame, done: false })
        return
      }
      queue.push(frame)
    },
    close() {
      if (closed) return
      closed = true
      if (waiting !== null) {
        const resolve = waiting
        waiting = null
        resolve({ value: undefined, done: true })
      }
    },
    next() {
      if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false })
      if (closed) return Promise.resolve({ value: undefined, done: true })
      return new Promise(resolve => { waiting = resolve })
    },
    return() {
      stream.close()
      return Promise.resolve({ value: undefined, done: true })
    },
    [Symbol.asyncIterator]() {
      return stream
    },
  }
  return stream
}

// One disposable browser + shell. Every scenario builds its own, except where a
// shared `storage` simulates a page refresh keeping localStorage.
function createHarness(options = {}) {
  const config = {
    notificationPermission: 'granted',
    audioState: 'running',
    hidden: false,
    storage: new Map(),
    ...options,
  }

  const notifications = []
  const tones = []
  const consoleLines = []
  const titleHistory = []
  const permissionRequests = { count: 0 }
  const streams = []
  const followSignals = []
  const remote = new Map()
  const shellEvents = new Map()
  const documentHandlers = new Map()
  const windowHandlers = new Map()
  const lockRequests = []
  const lockReleases = []
  const effects = []
  const registrations = []

  let title = 'DSH'
  let hidden = config.hidden
  let audioContext = null

  const localStorage = {
    getItem(key) {
      return config.storage.has(key) ? config.storage.get(key) : null
    },
    setItem(key, value) {
      config.storage.set(key, String(value))
    },
  }

  class FakeNotification {
    constructor(alertTitle, alertOptions) {
      notifications.push({ title: alertTitle, options: alertOptions !== null && alertOptions !== undefined ? alertOptions : {} })
    }
  }
  FakeNotification.permission = config.notificationPermission
  FakeNotification.requestPermission = () => {
    permissionRequests.count += 1
    FakeNotification.permission = 'granted'
    return Promise.resolve('granted')
  }

  class FakeAudioContext {
    constructor() {
      this.state = config.audioState
      this.currentTime = 1.5
      this.destination = { name: 'destination' }
      this.resumeCalls = 0
      audioContext = this
    }

    resume() {
      this.resumeCalls += 1
      this.state = 'running'
      return Promise.resolve()
    }

    createOscillator() {
      const oscillator = {
        type: 'sine',
        frequency: { value: 0 },
        connect() {},
        start(at) { tones.push({ frequency: oscillator.frequency.value, at }) },
        stop() {},
      }
      return oscillator
    }

    createGain() {
      return {
        gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {},
      }
    }
  }

  const document = {
    get title() { return title },
    set title(value) { title = value; titleHistory.push(value) },
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
    __ModuleLoader__: {
      load(registration) { registrations.push(registration) },
    },
    addEventListener(type, handler) {
      if (!windowHandlers.has(type)) windowHandlers.set(type, new Set())
      windowHandlers.get(type).add(handler)
    },
    removeEventListener(type, handler) {
      const set = windowHandlers.get(type)
      if (set !== undefined) set.delete(handler)
    },
  }

  const navigator = {
    locks: {
      request(name, _options, callback) {
        lockRequests.push(name)
        const result = callback()
        return Promise.resolve(result).then(() => { lockReleases.push(name) })
      },
    },
  }

  const quietConsole = {
    info: (...args) => consoleLines.push({ level: 'info', args }),
    warn: (...args) => consoleLines.push({ level: 'warn', args }),
    error: (...args) => consoleLines.push({ level: 'error', args }),
  }

  const ctx = {
    remote: {
      $on(event, handler) {
        if (!remote.has(event)) remote.set(event, new Set())
        remote.get(event).add(handler)
        return () => { remote.get(event).delete(handler) }
      },
      session: {
        follow(args, signal) {
          const stream = createStream()
          streams.push({ sessionId: args.address.sessionId, stream })
          followSignals.push(signal)
          if (signal !== undefined) {
            signal.addEventListener('abort', () => { stream.close() })
          }
          return stream
        },
      },
    },
    on(event, handler) {
      if (!shellEvents.has(event)) shellEvents.set(event, new Set())
      shellEvents.get(event).add(handler)
      return () => { shellEvents.get(event).delete(handler) }
    },
    effect(factory) {
      const cleanup = factory()
      effects.push(cleanup)
      return cleanup
    },
  }

  function emit(event, ...args) {
    const handlers = remote.get(event)
    if (handlers !== undefined) for (const handler of [...handlers]) handler(...args)
  }

  function emitShell(event, ...args) {
    const handlers = shellEvents.get(event)
    if (handlers !== undefined) for (const handler of [...handlers]) handler(...args)
  }

  function fireDocument(type) {
    const handlers = documentHandlers.get(type)
    if (handlers !== undefined) for (const handler of [...handlers]) handler({ type })
  }

  function fireWindow(type) {
    const handlers = windowHandlers.get(type)
    if (handlers !== undefined) for (const handler of [...handlers]) handler({ type })
  }

  function setHidden(next) {
    hidden = next
    fireDocument('visibilitychange')
  }

  function load() {
    // new Function parses the source exactly like a classic script and keeps
    // top-level `window` / `document` names resolvable as parameters.
    const evaluate = new Function(
      'window', 'document', 'Notification', 'AudioContext', 'localStorage', 'navigator',
      'console', 'setTimeout', 'clearTimeout', source,
    )
    evaluate(window, document, FakeNotification, FakeAudioContext, localStorage, navigator, quietConsole, setTimeout, clearTimeout)
    check('registration', registrations.length === 1, 'expected exactly one __ModuleLoader__.load registration, got ' + registrations.length)
    const registration = registrations[0]
    check('registration', registration.id === 'dsh-alert', 'module id is ' + String(registration.id))
    const module = registration.factory(() => { throw new Error('unexpected require') })
    check('registration', typeof module.apply === 'function', 'apply is not exported')
    check('registration', Array.isArray(module.inject) && module.inject.includes('remote.session'),
      'inject must contain remote.session; got ' + JSON.stringify(module.inject))
    module.apply(ctx)
    return module
  }

  // Wait for the follow stream of one session (or the newest one when the
  // scenario only ever watches a single session).
  async function waitForStream(sessionId) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const match = sessionId === undefined
        ? streams[streams.length - 1]
        : streams.find(entry => entry.sessionId === sessionId)
      if (match !== undefined) return match
      await tick()
    }
    throw new Error('no follow stream was opened for ' + String(sessionId))
  }

  return {
    config,
    notifications,
    tones,
    consoleLines,
    titleHistory,
    permissionRequests,
    streams,
    followSignals,
    lockRequests,
    lockReleases,
    effects,
    document,
    window,
    get title() { return title },
    get audioContext() { return audioContext },
    emit,
    emitShell,
    fireDocument,
    fireWindow,
    setHidden,
    load,
    waitForStream,
    storage: config.storage,
  }
}

const MAIN = 'session-main-0001'
const SUBAGENT = 'session-agent-0002'

function summary(sessionId, extra) {
  return { sessionId, agentAvailable: true, updatedAt: 1, running: false, blank: false, cwd: 'C:\\work\\demo', ...extra }
}

function turnEnd(seq, time, kind, error) {
  return {
    type: 'event',
    event: {
      type: 'turn/end',
      seq,
      time,
      data: { turn: 1, reason: kind === 'error' ? { kind, error: { message: error } } : { kind } },
    },
  }
}

function compactionEnd(seq, time, error) {
  return {
    type: 'event',
    event: {
      type: 'compaction/end',
      seq,
      time,
      data: error === undefined ? { compactionId: 'c1' } : { compactionId: 'c1', error },
    },
  }
}

const scenarios = []
function scenario(name, run) {
  scenarios.push({ name, run })
}

// Normal use: one completed round, observed while the tab is in the background.
scenario('roundCompleteAlertsOnce', async () => {
  const harness = createHarness({ hidden: true })
  harness.load()
  harness.emit('api-session/added', summary(MAIN))
  const { stream } = await harness.waitForStream()
  stream.push({ type: 'snapshot', records: [] })
  harness.emit('api-session/status', MAIN, true)
  await settle()
  stream.push(turnEnd(5, Date.now(), 'completed'))
  await settle()
  harness.emit('api-session/status', MAIN, false)
  await settle()
  await settle()

  check('roundCompleteAlertsOnce', harness.notifications.length === 1,
    'expected 1 notification, got ' + harness.notifications.length)
  check('roundCompleteAlertsOnce', harness.notifications[0].title.includes('complete'),
    'unexpected title ' + harness.notifications[0].title)
  check('roundCompleteAlertsOnce', harness.tones.length === 2,
    'expected 2 tone notes, got ' + harness.tones.length)
  check('roundCompleteAlertsOnce', harness.title.startsWith('(1)'), 'hidden tab title was not marked: ' + harness.title)
  // Returning to the tab clears the mark without a second alert.
  harness.setHidden(false)
  await settle()
  check('roundCompleteAlertsOnce', harness.title === 'DSH', 'title mark was not restored: ' + harness.title)
  check('roundCompleteAlertsOnce', harness.notifications.length === 1, 'returning to the tab alerted again')
})

// Repeat: the same round reported twice (turn/end then the status edge) must
// deliver exactly one alert.
scenario('secondRoundWithinSuppressionIsDropped', async () => {
  const harness = createHarness()
  harness.load()
  harness.emit('api-session/added', summary(MAIN))
  const { stream } = await harness.waitForStream()
  stream.push({ type: 'snapshot', records: [] })
  harness.emit('api-session/status', MAIN, true)
  await settle()
  stream.push(turnEnd(5, Date.now(), 'completed'))
  stream.push(turnEnd(6, Date.now() + 10, 'completed'))
  await settle()
  check('secondRoundWithinSuppressionIsDropped', harness.notifications.length === 1,
    'expected the second report to be suppressed, got ' + harness.notifications.length)
})

// Restart: a reconnect replays the session tail. The replayed turn/end must not
// alert again, and must not move the watermark backwards.
scenario('replayedTurnEndDoesNotAlert', async () => {
  const harness = createHarness()
  harness.load()
  harness.emit('api-session/added', summary(MAIN))
  const first = await harness.waitForStream()
  first.stream.push({ type: 'snapshot', records: [] })
  harness.emit('api-session/status', MAIN, true)
  await settle()
  first.stream.push(turnEnd(5, Date.now(), 'completed'))
  await settle()
  check('replayedTurnEndDoesNotAlert', harness.notifications.length === 1,
    'the live round did not alert')

  harness.emitShell('connection/reset')
  const second = await harness.waitForStream()
  check('replayedTurnEndDoesNotAlert', second !== first, 'the follow stream was not re-opened')
  const replayAt = Date.now() - 1000
  second.stream.push({ type: 'snapshot', records: [turnEnd(5, replayAt, 'completed')] })
  await settle()
  check('replayedTurnEndDoesNotAlert', harness.notifications.length === 1,
    'the replayed turn/end alerted again')
})

// A snapshot that proves a round finished while the page could not observe it
// alerts once — the catch-up path after a frozen tab or a lost connection.
scenario('snapshotCatchUpAlertsOnce', async () => {
  const storage = new Map()
  storage.set('dsh-alert/v1/marks', JSON.stringify({ v: 1, sessions: { [MAIN]: { turnSeq: 5, turnAt: 1, edgeAt: 1 } } }))
  const harness = createHarness({ storage })
  harness.load()
  harness.emit('api-session/added', summary(MAIN))
  const { stream } = await harness.waitForStream()
  stream.push({ type: 'snapshot', records: [turnEnd(9, Date.now(), 'completed')] })
  await settle()
  check('snapshotCatchUpAlertsOnce', harness.notifications.length === 1,
    'expected exactly one catch-up alert, got ' + harness.notifications.length)

  harness.emitShell('connection/reset')
  const second = await harness.waitForStream()
  second.stream.push({ type: 'snapshot', records: [turnEnd(9, Date.now(), 'completed')] })
  await settle()
  check('snapshotCatchUpAlertsOnce', harness.notifications.length === 1,
    'the same snapshot alerted a second time')
})

// On a fresh profile the first snapshot is a baseline, not news: a session last
// used yesterday must not alert when the page loads.
scenario('firstLoadSnapshotIsBaseline', async () => {
  const harness = createHarness()
  harness.load()
  harness.emit('api-session/added', summary(MAIN))
  const { stream } = await harness.waitForStream()
  stream.push({ type: 'snapshot', records: [turnEnd(40, Date.now() - 86400000, 'completed')] })
  await settle()
  check('firstLoadSnapshotIsBaseline', harness.notifications.length === 0,
    'a historical turn alerted on first sight')
  const marks = JSON.parse(harness.storage.get('dsh-alert/v1/marks'))
  check('firstLoadSnapshotIsBaseline', marks.sessions[MAIN].turnSeq === 40,
    'the baseline watermark was not adopted: ' + JSON.stringify(marks.sessions[MAIN]))
})

// Failure: the error event explains why, even when no turn/end frame arrives.
scenario('errorMessageExplainsFailure', async () => {
  const harness = createHarness()
  harness.load()
  harness.emit('api-session/added', summary(MAIN))
  await harness.waitForStream()
  harness.emit('api-session/status', MAIN, true)
  await settle()
  harness.emit('api-session/error', MAIN, 'provider returned 500')
  harness.emit('api-session/status', MAIN, false)
  await settle()
  await new Promise(resolve => setTimeout(resolve, 650))
  check('errorMessageExplainsFailure', harness.notifications.length === 1,
    'expected one failure alert, got ' + harness.notifications.length)
  check('errorMessageExplainsFailure', harness.notifications[0].title.includes('failed'),
    'unexpected title ' + harness.notifications[0].title)
  check('errorMessageExplainsFailure', (harness.notifications[0].options.body || '').includes('provider returned 500'),
    'the error message was not reported: ' + harness.notifications[0].options.body)
})

// A user-cancelled round is not news: the user is at the page and pressed stop.
scenario('abortedTurnIsSilent', async () => {
  const harness = createHarness()
  harness.load()
  harness.emit('api-session/added', summary(MAIN))
  const { stream } = await harness.waitForStream()
  stream.push({ type: 'snapshot', records: [] })
  harness.emit('api-session/status', MAIN, true)
  await settle()
  stream.push(turnEnd(7, Date.now(), 'aborted'))
  await settle()
  harness.emit('api-session/status', MAIN, false)
  await new Promise(resolve => setTimeout(resolve, 650))
  check('abortedTurnIsSilent', harness.notifications.length === 0,
    'an aborted turn alerted')
})

// Subagent rounds must never alert.
scenario('subagentIsIgnored', async () => {
  const harness = createHarness()
  harness.load()
  harness.emit('api-session/added', summary(SUBAGENT, { origin: 'subagent' }))
  await settle()
  harness.emit('api-session/status', SUBAGENT, true)
  await settle()
  harness.emit('api-session/status', SUBAGENT, false)
  await new Promise(resolve => setTimeout(resolve, 650))
  check('subagentIsIgnored', harness.notifications.length === 0, 'a subagent round alerted')
  check('subagentIsIgnored', harness.streams.length === 0, 'a subagent session was followed')
})

// Audio policy: a suspended context is not scheduled, because queued tones are
// heard only when the user returns to the tab — the original bug.
scenario('suspendedContextDoesNotQueueTone', async () => {
  const harness = createHarness({ audioState: 'suspended' })
  harness.load()
  harness.emit('api-session/added', summary(MAIN))
  const { stream } = await harness.waitForStream()
  stream.push({ type: 'snapshot', records: [] })
  harness.emit('api-session/status', MAIN, true)
  await settle()
  stream.push(turnEnd(5, Date.now(), 'completed'))
  await settle()
  check('suspendedContextDoesNotQueueTone', harness.tones.length === 0,
    'a tone was queued on a suspended context: ' + JSON.stringify(harness.tones))
  check('suspendedContextDoesNotQueueTone', harness.notifications.length === 1,
    'the notification did not cover the silent tone')
})

// The unread mark counts alerts instead of nesting prefixes.
scenario('twoUnreadAlertsKeepOnePrefix', async () => {
  const OTHER = 'session-main-0003'
  const harness = createHarness({ hidden: true })
  harness.load()
  harness.emit('api-session/added', summary(MAIN))
  harness.emit('api-session/added', summary(OTHER))
  const main = await harness.waitForStream(MAIN)
  const other = await harness.waitForStream(OTHER)
  main.stream.push({ type: 'snapshot', records: [] })
  other.stream.push({ type: 'snapshot', records: [] })
  harness.emit('api-session/status', MAIN, true)
  await settle()
  main.stream.push(turnEnd(5, Date.now(), 'completed'))
  await settle()
  harness.emit('api-session/status', OTHER, true)
  await settle()
  other.stream.push(turnEnd(6, Date.now() + 5, 'completed'))
  await settle()
  check('twoUnreadAlertsKeepOnePrefix', harness.notifications.length === 2,
    'expected two alerts from two sessions, got ' + harness.notifications.length)
  check('twoUnreadAlertsKeepOnePrefix', harness.title === '(2) DSH',
    'title was not a single counted prefix: ' + harness.title)
  harness.setHidden(false)
  await settle()
  check('twoUnreadAlertsKeepOnePrefix', harness.title === 'DSH', 'title was not restored: ' + harness.title)
})

// The keep-alive lock is held only while hidden with work in flight.
scenario('keepaliveLockHeldWhileHiddenRunning', async () => {
  const harness = createHarness({ hidden: true })
  harness.load()
  harness.emit('api-session/added', summary(MAIN))
  await harness.waitForStream()
  harness.emit('api-session/status', MAIN, true)
  await settle()
  check('keepaliveLockHeldWhileHiddenRunning', harness.lockRequests.length === 1,
    'no keep-alive lock was requested, got ' + harness.lockRequests.length)
  harness.setHidden(false)
  await settle()
  check('keepaliveLockHeldWhileHiddenRunning', harness.lockReleases.length === 1,
    'the keep-alive lock was not released on return')
})

// A gesture is the only moment audio and notification permission can be armed.
scenario('gestureArmsAudioAndPermission', async () => {
  const harness = createHarness({ notificationPermission: 'default', audioState: 'suspended' })
  harness.load()
  harness.emit('api-session/added', summary(MAIN))
  await harness.waitForStream()
  harness.fireDocument('pointerdown')
  await settle()
  check('gestureArmsAudioAndPermission', harness.permissionRequests.count === 1,
    'permission was not requested on the gesture, count ' + harness.permissionRequests.count)
  check('gestureArmsAudioAndPermission', harness.audioContext !== null && harness.audioContext.resumeCalls === 1,
    'audio was not resumed on the gesture')
  harness.fireDocument('pointerdown')
  await settle()
  check('gestureArmsAudioAndPermission', harness.permissionRequests.count === 1,
    'permission was requested more than once')
})

// Compaction keeps its own watermark, independent of rounds.
scenario('compactionAlertsOncePerEnd', async () => {
  const harness = createHarness()
  harness.load()
  harness.emit('api-session/added', summary(MAIN))
  const { stream } = await harness.waitForStream()
  stream.push({ type: 'snapshot', records: [] })
  stream.push({ type: 'event', event: { type: 'compaction/start', seq: 11, time: Date.now(), data: {} } })
  stream.push(compactionEnd(12, Date.now()))
  await settle()
  check('compactionAlertsOncePerEnd', harness.notifications.length === 1,
    'expected one compaction alert, got ' + harness.notifications.length)
  check('compactionAlertsOncePerEnd', harness.notifications[0].title.includes('compacted'),
    'unexpected title ' + harness.notifications[0].title)
  stream.push(compactionEnd(12, Date.now()))
  await settle()
  check('compactionAlertsOncePerEnd', harness.notifications.length === 1,
    'a replayed compaction/end alerted again')
})

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
