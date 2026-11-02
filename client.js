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
// WHAT THIS HALF DOES — AND DOES NOT DO
//   The alert itself (notification + sound) is raised by the Host half in
//   index.js, from `session/event`, so it does not involve a page at all: zero,
//   one, or ten tabs open all produce exactly one alert, and a background,
//   throttled, frozen, or closed tab changes nothing.
//
//   This half adds the one thing only a page can do: while the tab is in the
//   background, mark the tab title with the number of rounds that finished, so
//   returning to a long-idle tab shows what happened. It posts no notification
//   and plays no sound — that would double the Host alert — and it needs no
//   audio permission, no notification permission, and no user gesture.
//
// DATA PATH (Host-forwarded Remote events)
//   api-session/added   SessionSummary       -> identity, origin, working dir
//   api-session/status  (sessionId, running) -> the running edge that counts
//   api-session/error   (sessionId, message) -> marks the round as failed
//   api-session/removed (sessionId)          -> drop that session's state
//
// The `id` must match the package name and the profile patch row, or the loader
// registers a module nothing addresses.
window.__ModuleLoader__.load({
  id: 'dsh-alert',
  factory: () => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var VERSION = '0.3.0'
    var LOG = '[dsh-alert]'

    var warned = new Set()

    function log() {
      console.info.apply(console, [LOG].concat(Array.prototype.slice.call(arguments)))
    }

    // #FUNC Warn once per key so an unknown-session note cannot flood the console
    //       on every status event of a long round.
    // #WHY  `warned` is cleared only on teardown; the same session id repeats for
    //       the whole life of the page.
    function warnOnce(key, message) {
      if (warned.has(key)) return
      warned.add(key)
      console.warn(LOG, message)
    }

    var sessions = new Map() // sessionId -> { origin, cwd }
    var running = new Map() // sessionId -> last observed running flag
    var failing = new Set() // sessionId -> a round that reported an error
    var counts = { finished: 0, failed: 0, marks: 0 }
    var title = { original: null, marked: null, pending: 0 }

    // #FUNC Prefix the document title with the unread count.
    // #NOT  Does not run while the tab is visible; the user is watching the
    //       conversation and the Host notification already fired.
    // #EDGE-IN Two rounds while hidden -> "(2) <title>", never two prefixes →
    //           smoke: twoUnreadRoundsKeepOnePrefix
    // #WHY  `title.original` is captured once, so repeated marks cannot nest.
    function markTitle() {
      if (typeof document === 'undefined') return
      title.pending += 1
      if (title.original === null) title.original = document.title
      var next = '(' + title.pending + ') ' + title.original
      title.marked = next
      document.title = next
      counts.marks += 1
    }

    // #FUNC Restore the title the application was using before the mark.
    // #NOT  Does not restore a title the application changed in the meantime.
    // #WHY  The `title.marked` comparison keeps a session-title update that
    //       landed while the mark was up from being reverted.
    function clearTitle() {
      if (typeof document === 'undefined') return
      if (title.original !== null && document.title === title.marked) {
        document.title = title.original
      }
      title.original = null
      title.marked = null
      title.pending = 0
    }

    function isMain(sessionId) {
      var session = sessions.get(sessionId)
      return session !== undefined && session.origin !== 'subagent'
    }

    // #FUNC Count one finished round and mark the tab when the page is hidden.
    // #NOT  Does not post a notification and does not play a sound; the Host half
    //       owns both, so a page must never duplicate them.
    // #WHY  `document.hidden` gates the mark because a visible tab needs no
    //       indicator: the round's end is already on screen.
    function noteRound(sessionId, failed) {
      counts.finished += 1
      if (failed) counts.failed += 1
      log('round finished', sessionId, failed ? 'fail' : 'done')
      if (typeof document !== 'undefined' && document.hidden === true) markTitle()
    }

    function status() {
      return {
        version: VERSION,
        counts: counts,
        unread: title.pending,
        hidden: typeof document === 'undefined' ? undefined : document.hidden,
        sessions: Array.from(sessions.entries()).map(function (entry) {
          return { id: entry[0], origin: entry[1].origin, cwd: entry[1].cwd, running: running.get(entry[0]) }
        }),
      }
    }

    // #FUNC Cordis entry point: mount the tab-title half, and never break the page.
    // #NOT  Does not rethrow: the client loader treats a throwing plugin as a
    //       failed batch, which costs the user the whole interface.
    // #WHY  The `catch` logs instead because a missing title mark is a cosmetic
    //       loss, while a stuck boot page is not.
    function apply(ctx) {
      try {
        start(ctx)
      } catch (error) {
        console.error(LOG, 'could not start; the rest of the page is unaffected:', error)
      }
    }

    function start(ctx) {
      var disposers = []

      function own(disposer) {
        if (typeof disposer === 'function') disposers.push(disposer)
      }

      own(ctx.remote.$on('api-session/added', function (summary) {
        if (summary === null || typeof summary !== 'object') return
        var sessionId = summary.sessionId !== undefined ? summary.sessionId : summary.id
        if (typeof sessionId !== 'string') return
        sessions.set(sessionId, {
          origin: summary.origin === 'subagent' ? 'subagent' : 'main',
          cwd: typeof summary.cwd === 'string' ? summary.cwd : undefined,
        })
      }))

      own(ctx.remote.$on('api-session/status', function (sessionId, isRunning) {
        if (typeof sessionId !== 'string') return
        var previous = running.get(sessionId)
        running.set(sessionId, isRunning === true)
        if (isRunning === true) {
          failing.delete(sessionId)
          return
        }
        // Only a true -> false transition is a round boundary; the first
        // observation of a session has no baseline and must stay silent.
        if (previous !== true) return
        if (!isMain(sessionId)) {
          if (!sessions.has(sessionId)) {
            warnOnce('unknown:' + sessionId, 'round finished for a session the Host never announced (' + sessionId + '); the title mark needs its api-session/added summary')
          }
          return
        }
        noteRound(sessionId, failing.has(sessionId))
      }))

      own(ctx.remote.$on('api-session/error', function (sessionId) {
        if (typeof sessionId !== 'string') return
        failing.add(sessionId)
      }))

      own(ctx.remote.$on('api-session/removed', function (sessionId) {
        if (typeof sessionId !== 'string') return
        sessions.delete(sessionId)
        running.delete(sessionId)
        failing.delete(sessionId)
      }))

      function onVisible() {
        if (typeof document !== 'undefined' && document.hidden === true) return
        if (title.pending > 0) log('unread marks cleared on return', title.pending)
        clearTitle()
      }

      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVisible)
        if (typeof window !== 'undefined') window.addEventListener('focus', onVisible)
        disposers.push(function () {
          document.removeEventListener('visibilitychange', onVisible)
          if (typeof window !== 'undefined') window.removeEventListener('focus', onVisible)
        })
      }

      if (typeof window !== 'undefined') {
        window.dshAlert = {
          version: VERSION,
          status: status,
          clear: function () {
            clearTitle()
            return status()
          },
        }
      }

      ctx.effect(function () {
        return function () {
          for (var index = 0; index < disposers.length; index += 1) {
            try { disposers[index]() } catch (error) { console.warn(LOG, 'dispose failed: ' + String(error)) }
          }
          clearTitle()
          if (typeof window !== 'undefined') delete window.dshAlert
        }
      }, 'dsh-alert: cleanup')

      log('active', VERSION, 'title mark only; the OS alert comes from the Host half')
    }

    exports.apply = apply
    // Only the root remote service is used: this half opens no session stream, so
    // `remote.session` must NOT be injected — a missing namespace there is what
    // turns a watcher into a retry flood.
    exports.inject = ['remote']
    return module.exports
  },
})
