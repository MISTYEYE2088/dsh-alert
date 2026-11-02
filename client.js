// dsh-alert browser half, in the DSH client-modules artifact format.
//
// The Host serves this file verbatim, concatenated with every other client
// artifact into one classic-script combo (/plugins/??<id>/client.js,...), so it
// must not be an ES module: a top-level `import`/`export` is a SyntaxError in a
// classic script and takes the whole combo down with it. The file is one
// window.__ModuleLoader__.load({ id, factory }) registration; everything else
// lives inside the factory closure and apply/inject leave through
// module.exports.
//
// WHAT IT DOES
//   Alerts the user when an agent round or a context compaction finishes or
//   fails: a system notification, a short tone, and an unread mark on the tab
//   title while the tab is in the background.
//
// WHY IT IS NOT A REACT COMPONENT
//   The previous version hung its watcher on the conversation header, so it
//   observed only the session whose pane happened to be mounted and re-armed on
//   every remount. Alerts tied to a component lifetime cannot be exactly-once.
//   This version subscribes to the Host's forwarded session events at the
//   client root (apply() runs once per page load) and keeps its own durable
//   watermark per session, so it needs neither React nor a resident slot.
//
// DATA PATH (Host-forwarded Remote events; no polling)
//   api-session/added   SessionSummary       -> identity, origin, cwd
//   api-session/status  (sessionId, running) -> the running edge that alerts
//   api-session/error   (sessionId, message) -> why this round is failing
//   api-session/removed (sessionId)          -> drop watcher state
//   session.follow stream                    -> compaction/start|end and the
//                                               turn/end reason: enrichment, and
//                                               the catch-up window after a
//                                               freeze or a reconnect
//
// THE BACKGROUND-TAB PROBLEM (the reported "it only fires after I refocus")
//   A hidden tab is exactly when the alert matters, and exactly when browsers
//   push back:
//   - a Web Audio context starts `suspended` until a user gesture resumes it,
//     and oscillators scheduled against a suspended context are heard only once
//     it resumes — i.e. when the user comes back to the tab;
//   - Notification.requestPermission() needs transient user activation, so a
//     prompt from an alert handler without a prior gesture is refused;
//   - a long-hidden tab may be frozen by Chrome, so no page JavaScript runs.
//   So this version arms audio and permission from the first user gesture,
//   holds a Web Lock while hidden with work in flight (Chrome does not freeze
//   pages that hold one), marks the tab title while an alert is unread, and
//   reconciles every resume path (visibilitychange, focus, pageshow, resume,
//   connection/reset) against the durable watermark, so an edge that was
//   missed while frozen is still reported once — late, but never twice, and
//   never lost.
window.__ModuleLoader__.load({
  id: 'dsh-alert',
  factory: () => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var VERSION = '0.2.0'
    var LOG = '[dsh-alert]'

    // Versioned keys: a future schema change must not read a v1 watermark and
    // silently swallow the first alert of a round.
    var MARKS_KEY = 'dsh-alert/v1/marks'
    var KEEPALIVE_KEY = 'dsh-alert/v1/keepalive'
    var LOCK_NAME = 'dsh-alert/keepalive'

    // A status edge with no turn/end detail yet waits this long before
    // reporting a plain "complete"; turn/end carries the real outcome and
    // normally wins the race. A single fresh timer is not delayed by Chrome's
    // intensive throttling.
    var EDGE_GRACE_MS = 500
    // One round must never produce two alerts: turn/end and the status edge
    // describe the same fact and arrive on different channels.
    var ALERT_SUPPRESS_MS = 6000
    // api-session/error has no turn position, so it marks the current round
    // only while it is recent; a new running edge clears it.
    var ERROR_FRESH_MS = 60000
    // A tab hidden for less than this was almost certainly not frozen, so its
    // follow stream is intact and restarting it would only replay snapshots.
    var RESUME_RESTART_MS = 60000
    // Deterministic failures: retrying a missing injected service or a missing
    // module repeats the same error forever (the documented retry flood).
    var FATAL_PATTERN = /without inject|missed the module table|not a function|is not defined|unknown (method|event|property)/i

    var warned = new Set()

    function log() {
      console.info.apply(console, [LOG].concat(Array.prototype.slice.call(arguments)))
    }

    function warn() {
      console.warn.apply(console, [LOG].concat(Array.prototype.slice.call(arguments)))
    }

    // #FUNC Report one warning per key, so a retry loop cannot flood the console.
    // #WHY  `warned` exists because the same browser policy (blocked
    //       notification permission, suspended audio) repeats on every alert.
    function warnOnce(key, message) {
      if (warned.has(key)) return
      warned.add(key)
      warn(message)
    }

    function clip(value, max) {
      var text = typeof value === 'string' ? value : String(value)
      return text.length > max ? text.slice(0, max - 1) + '…' : text
    }

    function basename(value) {
      if (typeof value !== 'string' || value.length === 0) return undefined
      var parts = value.split(/[\\/]/).filter(function (part) { return part.length > 0 })
      return parts.length === 0 ? undefined : parts[parts.length - 1]
    }

    function delay(ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms) })
    }

    function readJson(key) {
      try {
        if (typeof localStorage === 'undefined') return undefined
        var raw = localStorage.getItem(key)
        if (raw === null || raw === undefined) return undefined
        var parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' ? parsed : undefined
      } catch (error) {
        warnOnce('storage-read', 'localStorage read failed: ' + String(error))
        return undefined
      }
    }

    function writeJson(key, value) {
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(key, JSON.stringify(value))
      } catch (error) {
        warnOnce('storage-write', 'localStorage write failed: ' + String(error))
      }
    }

    // Persisted per-session watermarks. A session id present in this object
    // means "this browser has seen this session's tail before", which is what
    // allows a replayed snapshot to be told apart from an unreported round.
    var marks = normalizeMarks(readJson(MARKS_KEY))

    function normalizeMarks(raw) {
      var sessions = raw !== undefined && raw.sessions !== null && typeof raw.sessions === 'object'
        ? raw.sessions
        : {}
      return { v: 1, sessions: sessions }
    }

    function peekMarks(sessionId) {
      var entry = marks.sessions[sessionId]
      return entry !== null && typeof entry === 'object' ? entry : undefined
    }

    function ensureMarks(sessionId) {
      var existing = peekMarks(sessionId)
      if (existing !== undefined) return existing
      var created = { turnSeq: -1, compactSeq: -1 }
      marks.sessions[sessionId] = created
      return created
    }

    function saveMarks() {
      writeJson(MARKS_KEY, marks)
    }

    // ---------------------------------------------------------------------
    // Tab title mark
    // ---------------------------------------------------------------------

    var titleMark = { original: null, marked: null, pending: 0 }

    // #FUNC Prefix the document title with the unread alert count.
    // #NOT  Does not touch the title while the tab is visible; the app owns it.
    // #EDGE-IN Two alerts while hidden -> "(2) <title>", not two prefixes →
    //           smoke: twoUnreadAlertsKeepOnePrefix
    // #WHY  `original` is captured once so repeated alerts cannot nest prefixes.
    function markTitle() {
      if (typeof document === 'undefined') return
      titleMark.pending += 1
      if (titleMark.original === null) titleMark.original = document.title
      var next = '(' + titleMark.pending + ') ' + titleMark.original
      titleMark.marked = next
      document.title = next
    }

    // #FUNC Drop the unread mark and restore the title the app was using.
    // #NOT  Does not restore a title the app changed itself in the meantime.
    // #WHY  The `titleMark.marked` comparison keeps a session-title update that
    //       landed while the mark was up from being reverted.
    function clearTitle() {
      if (typeof document === 'undefined') return
      if (titleMark.original !== null && document.title === titleMark.marked) {
        document.title = titleMark.original
      }
      titleMark.original = null
      titleMark.marked = null
      titleMark.pending = 0
    }

    // ---------------------------------------------------------------------
    // Audio
    // ---------------------------------------------------------------------

    var audio = { context: null, armed: false, failed: false }

    function audioContext() {
      if (audio.context !== null) return audio.context
      if (audio.failed) return null
      var Ctor = typeof AudioContext !== 'undefined'
        ? AudioContext
        : (typeof webkitAudioContext !== 'undefined' ? webkitAudioContext : undefined)
      if (Ctor === undefined) {
        audio.failed = true
        warnOnce('no-audio', 'no Web Audio API in this browser; alerts will be silent')
        return null
      }
      try {
        audio.context = new Ctor()
      } catch (error) {
        audio.failed = true
        warnOnce('no-audio', 'AudioContext creation failed: ' + String(error))
        return null
      }
      return audio.context
    }

    // #FUNC Resume the audio context from a user gesture so a later alert can
    //       actually be heard while the tab is hidden.
    // #NOT  Does not play anything; a confirmation tone on an ordinary click
    //       would be noise on every page.
    // #WHY  `audio.armed` tracks the gesture, because a context created before a
    //       gesture stays `suspended` and silently queues every later tone.
    function armAudio() {
      var context = audioContext()
      if (context === null) return
      if (context.state === 'running') {
        audio.armed = true
        return
      }
      try {
        var resumed = context.resume()
        if (resumed !== null && typeof resumed.then === 'function') {
          void resumed.then(function () {
            if (context.state === 'running' && !audio.armed) {
              audio.armed = true
              log('audio armed')
            }
          }).catch(function (error) {
            warnOnce('audio-resume', 'audio resume refused: ' + String(error))
          })
        }
      } catch (error) {
        warnOnce('audio-resume', 'audio resume threw: ' + String(error))
      }
    }

    // #FUNC Play the two-note alert tone.
    // #NOT  Does not schedule notes on a suspended context.
    // #EDGE-OUT Suspended context plays nothing and warns once, instead of
    //           queueing the tone until the user returns →
    //           smoke: suspendedContextDoesNotQueueTone
    // #WHY  Skipping the schedule is the fix for the reported symptom: notes
    //       queued behind `resume()` were the noise users heard on refocus.
    function playTone(failed) {
      var context = audioContext()
      if (context === null) return
      if (context.state !== 'running') {
        warnOnce('tone-suspended', 'audio is still suspended; click once inside the page to arm sound')
        void armAudio()
        return
      }
      try {
        var notes = failed ? [330, 262] : [880, 1174.66]
        var start = context.currentTime + 0.01
        for (var index = 0; index < notes.length; index += 1) {
          var oscillator = context.createOscillator()
          var gain = context.createGain()
          var begin = start + index * 0.16
          var duration = failed ? 0.24 : 0.14
          oscillator.type = failed ? 'triangle' : 'sine'
          oscillator.frequency.value = notes[index]
          gain.gain.setValueAtTime(0.0001, begin)
          gain.gain.exponentialRampToValueAtTime(0.16, begin + 0.02)
          gain.gain.exponentialRampToValueAtTime(0.0001, begin + duration)
          oscillator.connect(gain)
          gain.connect(context.destination)
          oscillator.start(begin)
          oscillator.stop(begin + duration + 0.02)
        }
      } catch (error) {
        warnOnce('tone-failed', 'tone playback failed: ' + String(error))
      }
    }

    // ---------------------------------------------------------------------
    // Notifications
    // ---------------------------------------------------------------------

    var askedPermission = false

    // #FUNC Ask for notification permission, but only from a user gesture.
    // #NOT  Does not re-prompt after a denial; Chrome refuses and the site
    //       setting has to change by hand.
    // #WHY  `askedPermission` guards transient activation: a prompt raised from
    //       an alert handler with no gesture is auto-denied, and the denial
    //       sticks for the whole origin.
    function requestPermission() {
      if (typeof Notification === 'undefined') {
        warnOnce('no-notification', 'Notification API unavailable; only the tone will play')
        return
      }
      if (askedPermission) return
      askedPermission = true
      if (Notification.permission !== 'default') {
        log('notification permission =', Notification.permission)
        return
      }
      try {
        var asked = Notification.requestPermission()
        if (asked !== null && typeof asked.then === 'function') {
          void asked.then(function (result) {
            log('notification permission =', result)
            if (result !== 'granted') {
              warnOnce('permission-denied', 'notifications were not granted; allow them for this site to see alerts')
            }
          }).catch(function (error) {
            warnOnce('permission-failed', 'notification permission request failed: ' + String(error))
          })
        }
      } catch (error) {
        warnOnce('permission-failed', 'notification permission request threw: ' + String(error))
      }
    }

    // #FUNC Post one system notification.
    // #NOT  Does not retry or escalate when permission is absent.
    // #WHY  The `tag` is the alert identity, so a duplicate delivery replaces the
    //       existing notification instead of stacking a second one.
    function notify(title, body, tag) {
      if (typeof Notification === 'undefined') return
      if (Notification.permission !== 'granted') {
        warnOnce('notify-unavailable', 'notification permission is ' + Notification.permission + '; allow notifications for this site')
        return
      }
      try {
        var options = { tag: tag }
        if (body !== undefined && body.length > 0) options.body = body
        new Notification(title, options)
      } catch (error) {
        warnOnce('notify-failed', 'notification failed: ' + String(error))
      }
    }

    // ---------------------------------------------------------------------
    // Session bookkeeping
    // ---------------------------------------------------------------------

    var sessions = new Map() // sessionId -> { origin, cwd }
    var running = new Map() // sessionId -> boolean (last observed)
    var failing = new Map() // sessionId -> { at, message }
    var lastAlertAt = new Map() // sessionId -> ms
    var alertCounts = { total: 0, suppressed: 0, unread: 0 }

    function describe(sessionId) {
      var session = sessions.get(sessionId)
      var label = session === undefined ? undefined : basename(session.cwd)
      return label !== undefined ? label : 'session ' + String(sessionId).slice(0, 8)
    }

    // #FUNC Whether a session may alert at all.
    // #WHY  `origin` is the only subagent marker the forwarded summary carries;
    //       a session of unknown origin is skipped and logged, because beeping
    //       for a subagent round would be worse than missing one.
    function isMain(sessionId) {
      var session = sessions.get(sessionId)
      if (session === undefined) return false
      return session.origin !== 'subagent'
    }

    function anyRunning() {
      var result = false
      running.forEach(function (value) { if (value === true) result = true })
      return result
    }

    // #FUNC Raise one alert: notification, tone, and the unread title mark.
    // #NOT  Does not decide whether an alert is owed; callers compare watermarks.
    // #EDGE-OUT Two reports for the same round inside `ALERT_SUPPRESS_MS` deliver
    //           once → smoke: secondRoundWithinSuppressionIsDropped
    // #WHY  `lastAlertAt` suppression exists because one round is reported twice,
    //       by the `turn/end` frame and by the `api-session/status` edge.
    function raiseAlert(kind, failed, message, sessionId, detail) {
      var now = Date.now()
      var previous = lastAlertAt.get(sessionId)
      if (previous !== undefined && now - previous < ALERT_SUPPRESS_MS) {
        alertCounts.suppressed += 1
        log('alert suppressed (same round already reported)', kind, sessionId)
        return false
      }
      lastAlertAt.set(sessionId, now)
      alertCounts.total += 1

      var headline = kind === 'compact'
        ? (failed ? 'Context compaction failed' : 'Context compacted')
        : (failed ? 'Round failed' : 'Round complete')
      var parts = [describe(sessionId)]
      if (detail !== undefined && detail !== 'completed') parts.push(detail)
      if (message !== undefined && message.length > 0) parts.push(clip(message, 200))
      var body = parts.join(' · ')

      log('alert', kind, failed ? 'fail' : 'done', sessionId)
      notify('DSH · ' + headline, body, sessionId + ':' + kind + ':' + now)
      playTone(failed)
      if (typeof document !== 'undefined' && document.hidden === true) {
        alertCounts.unread += 1
        markTitle()
      }
      return true
    }

    // #FUNC Record a completed round from a durable turn/end event and alert
    //       unless it was already reported.
    // #NOT  Does not alert for aborted or interrupted turns: the user stopped
    //       them and is already at the page.
    // #EDGE-IN `event.seq` at or below the watermark is a replay and is silent →
    //           smoke: replayedTurnEndDoesNotAlert
    // #WHY  `turnSeq` is the durable dedupe key, because a reconnect replays the
    //       session tail and every replay would otherwise be a new alert.
    function reportRound(sessionId, event, source) {
      var seq = event !== null && typeof event === 'object' && typeof event.seq === 'number'
        ? event.seq
        : -1
      var data = event !== null && typeof event === 'object' ? event.data : undefined
      var reason = data !== null && typeof data === 'object' ? data.reason : undefined
      var kind = reason !== null && typeof reason === 'object' && typeof reason.kind === 'string'
        ? reason.kind
        : 'unknown'
      var message = undefined
      if (reason !== null && typeof reason === 'object') {
        if (typeof reason.error === 'string') message = reason.error
        else if (reason.error !== null && typeof reason.error === 'object'
          && typeof reason.error.message === 'string') message = reason.error.message
      }

      var existing = peekMarks(sessionId)
      if (existing !== undefined && seq <= existing.turnSeq) return false

      var own = ensureMarks(sessionId)
      own.turnSeq = seq
      if (event !== null && typeof event === 'object' && typeof event.time === 'number') own.turnAt = event.time
      own.edgeAt = Date.now()
      saveMarks()

      if (kind === 'aborted' || kind === 'interrupted' || kind === 'disposed') {
        log('round ended without an alert (' + kind + ')', sessionId, source)
        return false
      }
      return raiseAlert('round', kind === 'error', message, sessionId, kind)
    }

    // #FUNC Record a completed compaction and alert unless it was already
    //       reported.
    // #EDGE-IN `event.seq` at or below the watermark is a replay and is silent →
    //           smoke: replayedCompactionEndDoesNotAlert
    // #WHY  `compactSeq` is separate from `turnSeq` because compactions and
    //       rounds share one session log but have independent sequence gaps.
    function reportCompaction(sessionId, event) {
      var seq = event !== null && typeof event === 'object' && typeof event.seq === 'number'
        ? event.seq
        : -1
      var data = event !== null && typeof event === 'object' ? event.data : undefined
      var failed = data !== null && typeof data === 'object'
        && typeof data.error === 'string' && data.error.length > 0

      var existing = peekMarks(sessionId)
      if (existing !== undefined && seq <= existing.compactSeq) return false

      var own = ensureMarks(sessionId)
      own.compactSeq = seq
      own.edgeAt = Date.now()
      saveMarks()

      return raiseAlert('compact', failed, failed ? data.error : undefined, sessionId, undefined)
    }

    // #FUNC Read the interesting tail of a follow snapshot.
    // #NOT  Does not distinguish "no turn ever" from "no turn in this window".
    // #WHY  `tail` is scanned backwards because the opening snapshot is a window
    //       over the session end, and only the newest event of each kind can be
    //       the unreported one.
    function scanTail(records) {
      var tail = { turn: undefined, compact: undefined }
      if (!Array.isArray(records)) return tail
      for (var index = records.length - 1; index >= 0; index -= 1) {
        var entry = records[index]
        if (entry === null || typeof entry !== 'object' || entry.type !== 'event') continue
        var event = entry.event
        if (event === null || typeof event !== 'object') continue
        if (event.type === 'turn/end' && tail.turn === undefined) tail.turn = event
        if (event.type === 'compaction/end' && tail.compact === undefined) tail.compact = event
      }
      return tail
    }

    // #FUNC Adopt a follow snapshot as a baseline, or report what it proves was
    //       missed while the page could not observe events.
    // #NOT  Never alerts on the very first sight of a session: that would report
    //       a round from hours ago on every fresh browser profile.
    // #EDGE-IN A snapshot whose turn/end is newer than the watermark is reported
    //           once → smoke: snapshotCatchUpAlertsOnce
    // #WHY  `edgeAt` separates the two cases: an event at or before it was
    //       already reported through the status edge, which knows no sequence.
    function handleSnapshot(sessionId, records) {
      var tail = scanTail(records)
      if (tail.turn !== undefined) {
        var existing = peekMarks(sessionId)
        if (existing === undefined) {
          var own = ensureMarks(sessionId)
          own.turnSeq = typeof tail.turn.seq === 'number' ? tail.turn.seq : -1
          if (typeof tail.turn.time === 'number') own.turnAt = tail.turn.time
          saveMarks()
          log('baseline adopted for', sessionId)
        } else {
          var seq = typeof tail.turn.seq === 'number' ? tail.turn.seq : -1
          if (seq > existing.turnSeq) {
            var time = typeof tail.turn.time === 'number' ? tail.turn.time : undefined
            if (existing.edgeAt !== undefined && time !== undefined && time <= existing.edgeAt) {
              existing.turnSeq = seq
              saveMarks()
              log('snapshot confirms a round already reported', sessionId)
            } else {
              reportRound(sessionId, tail.turn, 'snapshot')
            }
          }
        }
      }
      if (tail.compact !== undefined) {
        var marksNow = peekMarks(sessionId)
        var compactSeq = typeof tail.compact.seq === 'number' ? tail.compact.seq : -1
        if (marksNow !== undefined && compactSeq > marksNow.compactSeq) {
          reportCompaction(sessionId, tail.compact)
        } else if (marksNow === undefined) {
          var created = ensureMarks(sessionId)
          created.compactSeq = compactSeq
          saveMarks()
        }
      }
    }

    // ---------------------------------------------------------------------
    // Follow watchers
    // ---------------------------------------------------------------------

    var followWatchers = new Map() // sessionId -> { controller, generation, loops }
    var followFatal = new Set()

    // #FUNC Tail one attached session's durable event log for compaction and
    //       turn boundaries.
    // #NOT  Does not retry a deterministic failure: a missing injected service
    //       or module would fail identically on every attempt.
    // #WHY  `FATAL_PATTERN` separates a broken artifact from a transient
    //       transport loss, so one configuration error cannot flood the console.
    function startFollow(ctx, sessionId, entry, generation) {
      var signal = entry.controller.signal
      entry.loops += 1
      void (async function () {
        var attempt = 0
        try {
          while (!signal.aborted && entry.generation === generation) {
            try {
              for await (var frame of ctx.remote.session.follow(
                { address: { kind: 'session', sessionId: sessionId } },
                signal,
              )) {
                if (signal.aborted || entry.generation !== generation) return
                if (frame === null || typeof frame !== 'object') continue
                if (frame.type === 'snapshot') {
                  handleSnapshot(sessionId, frame.records)
                } else if (frame.type === 'event' && frame.event !== null && typeof frame.event === 'object') {
                  var event = frame.event
                  if (event.type === 'turn/end') reportRound(sessionId, event, 'live')
                  else if (event.type === 'compaction/end') reportCompaction(sessionId, event)
                }
              }
              return
            } catch (error) {
              if (signal.aborted || entry.generation !== generation) return
              var message = String(error !== null && typeof error === 'object' && error.message !== undefined
                ? error.message
                : error)
              if (FATAL_PATTERN.test(message)) {
                followFatal.add(sessionId)
                warn('follow disabled for ' + sessionId + ': ' + message)
                return
              }
              attempt += 1
              log('follow retry ' + attempt + ' for ' + sessionId + ': ' + message)
              await delay(Math.min(500 + attempt * 500, 4000))
            }
          }
        } finally {
          entry.loops -= 1
        }
      })()
    }

    function armWatcher(ctx, sessionId) {
      if (followWatchers.has(sessionId) || followFatal.has(sessionId)) return
      var entry = { controller: new AbortController(), generation: 0, loops: 0 }
      followWatchers.set(sessionId, entry)
      entry.generation += 1
      startFollow(ctx, sessionId, entry, entry.generation)
      log('watching', sessionId)
    }

    function disarmWatcher(sessionId) {
      var entry = followWatchers.get(sessionId)
      if (entry === undefined) return
      followWatchers.delete(sessionId)
      entry.generation += 1
      entry.controller.abort()
      log('stopped watching', sessionId)
    }

    // #FUNC Re-open every follow stream so each one delivers a fresh snapshot.
    // #WHY  `reason` is logged because only a reconnect, a page restore, or a
    //       long hidden period can invalidate the streams; a null reason would
    //       hide which resume path lost them.
    function restartWatchers(ctx, reason) {
      if (followWatchers.size === 0) return
      log('re-arming ' + followWatchers.size + ' watcher(s) after ' + reason)
      followWatchers.forEach(function (entry, sessionId) {
        entry.generation += 1
        entry.controller.abort()
        entry.controller = new AbortController()
        startFollow(ctx, sessionId, entry, entry.generation)
      })
    }

    // ---------------------------------------------------------------------
    // Keep-alive lock
    // ---------------------------------------------------------------------

    var keepalive = {
      enabled: (function () {
        try {
          return typeof localStorage === 'undefined' ? true : localStorage.getItem(KEEPALIVE_KEY) !== '0'
        } catch (error) {
          return true
        }
      })(),
      release: null,
      held: false,
    }

    // #FUNC Hold a Web Lock while the tab is hidden with work in flight.
    // #NOT  Does not guarantee the tab stays unfrozen; it only removes the
    //       cheapest reason for Chrome to freeze it.
    // #WHY  `LOCK_NAME` is this plugin's own lock: acquiring it must never wait
    //       behind another page's lock, and holding it must not block anything.
    function holdLock() {
      if (!keepalive.enabled || keepalive.held) return
      if (typeof navigator === 'undefined' || navigator.locks === undefined
        || typeof navigator.locks.request !== 'function') {
        warnOnce('no-locks', 'navigator.locks unavailable; a hidden tab may be frozen')
        keepalive.enabled = false
        return
      }
      keepalive.held = true
      var released = false
      try {
        void navigator.locks.request(LOCK_NAME, { mode: 'exclusive' }, function () {
          log('keep-alive lock held')
          return new Promise(function (resolve) {
            keepalive.release = function () {
              if (released) return
              released = true
              resolve()
            }
          })
        }).catch(function (error) {
          keepalive.held = false
          warnOnce('lock-failed', 'keep-alive lock failed: ' + String(error))
        })
      } catch (error) {
        keepalive.held = false
        warnOnce('lock-failed', 'keep-alive lock threw: ' + String(error))
      }
    }

    function dropLock() {
      var release = keepalive.release
      keepalive.release = null
      if (release !== null) release()
      keepalive.held = false
    }

    // #FUNC Decide whether the tab needs the keep-alive lock right now.
    // #WHY  `anyRunning` is the condition that matters: an idle tab has nothing
    //       to report, so holding a lock then would be pure battery cost.
    function syncKeepalive() {
      if (typeof document === 'undefined') return
      var needed = document.hidden === true && (anyRunning() || alertCounts.unread > 0)
      if (needed) holdLock()
      else dropLock()
    }

    // ---------------------------------------------------------------------
    // Status edges
    // ---------------------------------------------------------------------

    var edgeTimers = new Map()

    // #FUNC Report a round that the status flag says ended but no turn/end
    //       frame explained within the grace window.
    // #NOT  Does not report when a turn/end frame already reported this round.
    // #WHY  `edgeTimers` exists because the turn/end frame usually arrives first
    //       and carries the real outcome; the timer is the fallback for a
    //       session with no usable follow stream.
    function scheduleEdgeReport(sessionId) {
      var pending = edgeTimers.get(sessionId)
      if (pending !== undefined) clearTimeout(pending)
      var timer = setTimeout(function () {
        edgeTimers.delete(sessionId)
        var marksNow = peekMarks(sessionId)
        if (marksNow !== undefined && marksNow.edgeAt !== undefined
          && Date.now() - marksNow.edgeAt < ALERT_SUPPRESS_MS) {
          log('status edge already explained by turn/end', sessionId)
          return
        }
        var failure = failing.get(sessionId)
        var message = failure !== undefined && Date.now() - failure.at < ERROR_FRESH_MS
          ? failure.message
          : undefined
        var own = ensureMarks(sessionId)
        own.edgeAt = Date.now()
        saveMarks()
        raiseAlert('round', message !== undefined, message, sessionId, undefined)
      }, EDGE_GRACE_MS)
      edgeTimers.set(sessionId, timer)
    }

    // ---------------------------------------------------------------------
    // Diagnostics surface
    // ---------------------------------------------------------------------

    function status() {
      return {
        version: VERSION,
        audio: {
          state: audio.context === null ? 'absent' : audio.context.state,
          armed: audio.armed,
        },
        notification: typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
        keepalive: { enabled: keepalive.enabled, held: keepalive.held },
        watched: Array.from(followWatchers.keys()),
        running: Array.from(running.entries()),
        alerts: alertCounts,
        marks: marks.sessions,
        hidden: typeof document === 'undefined' ? undefined : document.hidden,
      }
    }

    function apply(ctx) {
      var disposers = []
      var hiddenSince = undefined

      function own(disposer) {
        if (typeof disposer === 'function') disposers.push(disposer)
      }

      own(ctx.remote.$on('api-session/added', function (summary) {
        if (summary === null || typeof summary !== 'object') return
        var sessionId = summary.sessionId !== undefined ? summary.sessionId : summary.id
        if (typeof sessionId !== 'string') return
        var origin = summary.origin === 'subagent' ? 'subagent' : 'main'
        sessions.set(sessionId, {
          origin: origin,
          cwd: typeof summary.cwd === 'string' ? summary.cwd : undefined,
        })
        if (origin === 'subagent') return
        armWatcher(ctx, sessionId)
        syncKeepalive()
      }))

      own(ctx.remote.$on('api-session/removed', function (sessionId) {
        if (typeof sessionId !== 'string') return
        disarmWatcher(sessionId)
        sessions.delete(sessionId)
        running.delete(sessionId)
        failing.delete(sessionId)
        lastAlertAt.delete(sessionId)
        var timer = edgeTimers.get(sessionId)
        if (timer !== undefined) {
          clearTimeout(timer)
          edgeTimers.delete(sessionId)
        }
        syncKeepalive()
      }))

      own(ctx.remote.$on('api-session/status', function (sessionId, isRunning) {
        if (typeof sessionId !== 'string') return
        var previous = running.get(sessionId)
        running.set(sessionId, isRunning === true)
        if (isRunning === true) {
          failing.delete(sessionId)
          var pending = edgeTimers.get(sessionId)
          if (pending !== undefined) {
            clearTimeout(pending)
            edgeTimers.delete(sessionId)
          }
          syncKeepalive()
          return
        }
        if (!isMain(sessionId)) {
          if (sessions.has(sessionId)) log('ignoring subagent status', sessionId)
          else warnOnce('unknown-session:' + sessionId, 'status for an unknown session ' + sessionId + '; alerts need its api-session/added summary')
          syncKeepalive()
          return
        }
        // A running edge from true to false is the round-end signal. The very
        // first observation of a session has no baseline and must not alert:
        // that would page the user for every historical session on page load.
        if (previous !== true) {
          log('status baseline for', sessionId, isRunning)
          syncKeepalive()
          return
        }
        log('status edge: round finished', sessionId)
        scheduleEdgeReport(sessionId)
        syncKeepalive()
      }))

      own(ctx.remote.$on('api-session/error', function (sessionId, message) {
        if (typeof sessionId !== 'string') return
        failing.set(sessionId, {
          at: Date.now(),
          message: typeof message === 'string' ? message : String(message),
        })
        log('session error recorded', sessionId)
      }))

      own(ctx.on('connection/reset', function () {
        restartWatchers(ctx, 'connection reset')
      }))

      function onGesture() {
        requestPermission()
        armAudio()
      }

      function onVisibility() {
        if (typeof document === 'undefined') return
        if (document.hidden === true) {
          hiddenSince = Date.now()
          // A gesture has already happened by the time a tab is hidden, so this
          // resume normally succeeds and keeps the tone audible while hidden.
          armAudio()
          syncKeepalive()
          return
        }
        var away = hiddenSince === undefined ? 0 : Date.now() - hiddenSince
        hiddenSince = undefined
        syncKeepalive()
        clearTitle()
        alertCounts.unread = 0
        if (away > RESUME_RESTART_MS) restartWatchers(ctx, 'a ' + Math.round(away / 1000) + 's hidden period')
      }

      function onPageShow(event) {
        if (event !== null && typeof event === 'object' && event.persisted === true) {
          restartWatchers(ctx, 'back/forward cache restore')
        }
        clearTitle()
        alertCounts.unread = 0
        syncKeepalive()
      }

      function onResume() {
        restartWatchers(ctx, 'page resume')
        syncKeepalive()
      }

      function onFreeze() {
        log('page frozen')
      }

      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVisibility)
        document.addEventListener('freeze', onFreeze)
        document.addEventListener('resume', onResume)
        document.addEventListener('pointerdown', onGesture, true)
        document.addEventListener('keydown', onGesture, true)
        if (typeof window !== 'undefined') {
          window.addEventListener('focus', onVisibility)
          window.addEventListener('pageshow', onPageShow)
        }
        disposers.push(function () {
          document.removeEventListener('visibilitychange', onVisibility)
          document.removeEventListener('freeze', onFreeze)
          document.removeEventListener('resume', onResume)
          document.removeEventListener('pointerdown', onGesture, true)
          document.removeEventListener('keydown', onGesture, true)
          if (typeof window !== 'undefined') {
            window.removeEventListener('focus', onVisibility)
            window.removeEventListener('pageshow', onPageShow)
          }
        })
      }

      if (typeof window !== 'undefined') {
        window.dshAlert = {
          version: VERSION,
          status: status,
          test: function (failed) {
            return raiseAlert('round', failed === true, 'manual test', 'dsh-alert:test', undefined)
          },
          arm: function () {
            requestPermission()
            armAudio()
            return status()
          },
          keepalive: function (enabled) {
            keepalive.enabled = enabled !== false
            writeJson(KEEPALIVE_KEY, keepalive.enabled)
            syncKeepalive()
            return keepalive.enabled
          },
        }
      }

      ctx.effect(function () {
        return function () {
          for (var index = 0; index < disposers.length; index += 1) {
            try { disposers[index]() } catch (error) { warn('dispose failed: ' + String(error)) }
          }
          edgeTimers.forEach(function (timer) { clearTimeout(timer) })
          edgeTimers.clear()
          followWatchers.forEach(function (entry) {
            entry.generation += 1
            entry.controller.abort()
          })
          followWatchers.clear()
          dropLock()
          clearTitle()
          if (typeof window !== 'undefined') delete window.dshAlert
        }
      }, 'dsh-alert: cleanup')

      log('active', VERSION, {
        audio: audio.context === null ? 'absent' : audio.context.state,
        notification: typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
        keepalive: keepalive.enabled,
      })
    }

    exports.apply = apply
    // `remote.session` is the generated namespace behind session.follow();
    // injecting only `remote` leaves it guarded, and the first follow call then
    // throws "cannot get property remote.session without inject" on every retry.
    exports.inject = ['remote', 'remote.session']
    return module.exports
  },
})
