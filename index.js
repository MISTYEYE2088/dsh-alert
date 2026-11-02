// dsh-alert host half.
//
// This is where the alert is actually raised. The browser half only marks the
// tab title; the OS notification and the sound come from the Harness process, so
// they work with zero, one, or ten browser tabs open — and they keep working
// when the tab is in the background, throttled, frozen, or closed.
//
// Data path: `session/event` is the post-commit append feed of every session
// log (packages/core/session). A round ends with `turn/end`, whose
// `data.reason` is the merge-extensible TurnEndReason:
//
//   completed            the round finished normally
//   error                the round failed; `error` is a structured LlmFailure
//   aborted              the user cancelled the round
//   max-tokens           a step hit its output ceiling
//   blocked              the turn never entered a step
//   interrupted, forked  log bookkeeping on resume/fork, never a live round
//
// Compaction is `compaction/end`, whose `data.error` is set when the summary was
// rejected. Both event kinds carry `seq` and `time`, so one alert per event is
// enough: the process sees each committed event exactly once.
//
// Subagent sessions are filtered out by `session.header.origin === 'subagent'`:
// a spawned worker finishing is not the user's turn.
import process from 'node:process'

import { createNotifier } from './notifier.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-alert'

/**
 * `DSH_ALERT_DRY_RUN=1` logs what would be announced instead of touching the
 * desktop. It exists so `tools/boot-check.mjs` can mount this plugin in a real
 * Cordis context without popping a toast.
 */
const DRY_RUN = () => process.env.DSH_ALERT_DRY_RUN === '1'

/** Defaults; a profile patch row may override any of them under `config:`. */
const DEFAULTS = Object.freeze({
  enabled: true,
  notify: true,
  sound: true,
  alertOnCompaction: true,
  alertOnAborted: false,
  titlePrefix: 'DSH',
})

// NOTE: this package deliberately exports NO `Config`.
//
// Cordis calls `runtime.Config["~standard"].validate(config)` before apply()
// (vendor/cordis/lib/index.js, `resolveConfig`). A plain object of defaults — the
// shape a hand-written plugin naturally reaches for — makes that throw
// `TypeError: Cannot read properties of undefined (reading 'validate')`, and the
// loader treats it as a fatal startup error: the whole profile stops booting.
// Omitting `Config` makes Cordis pass the row config through untouched, which is
// what `mergeSettings` below handles. If a schema is ever added here, it must be
// a real Standard Schema (for example schemastery), not a literal.

/** Merge one row config over the defaults. */
function mergeSettings(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const merged = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    if (source[key] !== undefined) merged[key] = source[key]
  }
  return merged
}

/** Last path segment, used as the session label in a notification body. */
function basename(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const parts = value.split(/[\\/]/).filter(part => part.length > 0)
  return parts.length === 0 ? undefined : parts[parts.length - 1]
}

function clip(value, max) {
  const text = typeof value === 'string' ? value : String(value)
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

/** Session label: the working-directory name, else a short session id. */
function labelOf(session) {
  const header = session !== null && typeof session === 'object' ? session.header : undefined
  const directory = header !== null && typeof header === 'object' ? basename(header.cwd) : undefined
  if (directory !== undefined) return directory
  const id = session !== null && typeof session === 'object' ? session.id : undefined
  return 'session ' + String(id ?? '?').slice(0, 8)
}

// #FUNC Decide whether one session event is worth an alert, and render its text.
// #NOT  Does not send anything, does not read the clock, and has no side effect:
//       the caller owns delivery.
// #EDGE-IN A subagent session's turn/end returns undefined →
//           smoke: hostSubagentIgnored
// #EDGE-OUT An `aborted` round is silent unless `alertOnAborted` is set →
//           smoke: hostAbortedSilentByDefault
// #WHY  `kind` is read from `data.reason.kind` rather than from `data.reason`
//       itself, because TurnEndReason is a merge-extensible sum type whose
//       variants other plugins can add.
export function describeSessionEvent(session, event, settings = DEFAULTS) {
  if (event === null || typeof event !== 'object') return undefined
  const header = session !== null && typeof session === 'object' ? session.header : undefined
  if (header !== null && typeof header === 'object' && header.origin === 'subagent') return undefined
  const label = labelOf(session)
  const prefix = typeof settings.titlePrefix === 'string' && settings.titlePrefix.length > 0
    ? settings.titlePrefix
    : DEFAULTS.titlePrefix
  const data = event.data !== null && typeof event.data === 'object' ? event.data : {}

  if (event.type === 'turn/end') {
    const reason = data.reason !== null && typeof data.reason === 'object' ? data.reason : {}
    const kind = typeof reason.kind === 'string' ? reason.kind : 'unknown'
    if (kind === 'interrupted' || kind === 'forked' || kind === 'blocked') return undefined
    if (kind === 'aborted' && settings.alertOnAborted !== true) return undefined
    const failed = kind === 'error'
    const turn = typeof data.turn === 'number' ? data.turn : undefined
    const parts = [label]
    if (turn !== undefined) parts.push('turn ' + turn)
    if (kind !== 'completed' && kind !== 'error' && kind !== 'aborted') parts.push(kind)
    const failure = reason.error !== null && typeof reason.error === 'object' ? reason.error : undefined
    const message = failure !== undefined && typeof failure.message === 'string'
      ? failure.message
      : undefined
    if (message !== undefined && message.length > 0) parts.push(clip(message, 200))
    return {
      kind: 'round',
      failed,
      title: prefix + ' · ' + (failed ? 'Round failed' : kind === 'aborted' ? 'Round cancelled' : 'Round complete'),
      body: parts.join(' · '),
      sessionId: session !== null && typeof session === 'object' ? session.id : undefined,
      seq: event.seq,
    }
  }

  if (event.type === 'compaction/end') {
    if (settings.alertOnCompaction !== true) return undefined
    const failed = typeof data.error === 'string' && data.error.length > 0
    const parts = [label]
    if (typeof data.turn === 'number') parts.push('turn ' + data.turn)
    if (failed) parts.push(clip(data.error, 200))
    return {
      kind: 'compact',
      failed,
      title: prefix + ' · ' + (failed ? 'Compaction failed' : 'Context compacted'),
      body: parts.join(' · '),
      sessionId: session !== null && typeof session === 'object' ? session.id : undefined,
      seq: event.seq,
    }
  }

  return undefined
}

// #FUNC Wire session events to the OS notifier.
// #NOT  Does not inspect the browser, the active session, or the user's focus:
//       the alert is deliberately decoupled from every page.
// #WHY  `delivered` keyed by session id, event type, and `seq` exists because the
//       same committed event must never produce two notifications, however many
//       times the loader re-applies the plugin.
export function applyWith(ctx, config, deps = {}) {
  const settings = mergeSettings(config)
  const log = deps.log ?? ((...args) => console.info('[dsh-alert]', ...args))
  const warn = deps.warn ?? ((message) => console.warn('[dsh-alert] ' + message))

  if (settings.enabled !== true) {
    log('disabled by config')
    return
  }

  const notifier = deps.notifier ?? (DRY_RUN()
    ? {
        platform: 'dry-run',
        send: (alert) => {
          log('dry-run', alert.title, '·', alert.body)
          return false
        },
      }
    : createNotifier({ warn }))
  const delivered = new Set()

  const dispose = ctx.on('session/event', (session, event) => {
    let alert
    try {
      alert = describeSessionEvent(session, event, settings)
    } catch (error) {
      warn('could not inspect session event: ' + String(error))
      return
    }
    if (alert === undefined) return

    const key = String(alert.sessionId) + ':' + String(event.type) + ':' + String(event.seq)
    if (delivered.has(key)) return
    delivered.add(key)
    if (delivered.size > 500) delivered.clear()

    log('alert', alert.title, '·', alert.body)
    try {
      notifier.send(alert, { notify: settings.notify !== false, sound: settings.sound !== false })
    } catch (error) {
      warn('notifier threw: ' + String(error))
    }
  })

  ctx.effect(() => () => {
    if (typeof dispose === 'function') dispose()
  }, 'dsh-alert: session events')

  log('active', {
    platform: notifier.platform ?? deps.platform ?? 'unknown',
    notify: settings.notify,
    sound: settings.sound,
    compaction: settings.alertOnCompaction,
    aborted: settings.alertOnAborted,
  })
}

// #FUNC Cordis entry point: mount the plugin, and never let it break the boot.
// #NOT  Does not rethrow: `applyWith` stays strict so tests see real failures,
//       while a runtime surprise here would otherwise cost the user their whole
//       profile (the loader treats a throwing plugin row as a fatal startup
//       error, not as one missing feature).
// #WHY  The `catch` logs instead of rethrowing because alerting is a side
//       feature: an agent that starts without notifications is usable, an agent
//       that does not start is not.
export function apply(ctx, config) {
  try {
    applyWith(ctx, config, {})
  } catch (error) {
    console.error('[dsh-alert] could not start; the rest of the profile is unaffected:', error)
  }
}
