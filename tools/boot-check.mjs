// Boot check: mount this plugin in a REAL Cordis context.
//
// A broken plugin row is not a missing feature — the loader treats a plugin that
// cannot be imported or applied as a startup error, so a malformed
// `package.json`, a `Config` export the loader cannot use, or an `apply` that
// throws can cost the user the whole profile. The fake context in
// tools/smoke.mjs cannot catch that class of failure; this script can.
//
//   node tools/boot-check.mjs [path-or-package-of-cordis]
//
// Defaults to resolving `@deepseek-ai/cordis`. For a DSH source checkout:
//
//   node tools/boot-check.mjs "C:/portable_software/dsh/deepseek-harness/node_modules/@deepseek-ai/cordis"
//
// or, from inside an installed profile:
//
//   node tools/boot-check.mjs "$HOME/.dsh/profiles/node_modules/@deepseek-ai/cordis"
//
// Notifications are disabled for the run (DSH_ALERT_DRY_RUN), so it is safe to
// run on a machine you are using.

import { pathToFileURL } from 'node:url'

process.env.DSH_ALERT_DRY_RUN = '1'

const specifier = process.argv[2]
const cordisSpec = specifier === undefined
  ? '@deepseek-ai/cordis'
  : /^[a-zA-Z]:[\\/]/.test(specifier) || specifier.startsWith('/') || specifier.startsWith('.')
    ? pathToFileURL(specifier.endsWith('.js') ? specifier : specifier.replace(/[\\/]+$/, '') + '/lib/index.js').href
    : specifier

const lines = []
const errors = []
const originalInfo = console.info
const originalError = console.error
const originalWarn = console.warn
console.info = (...args) => { lines.push(args.map(String).join(' ')); originalInfo(...args) }
console.error = (...args) => { errors.push(args.map(formatError).join(' ')); originalError(...args) }
console.warn = (...args) => { lines.push('warn ' + args.map(String).join(' ')) }

function formatError(value) {
  if (value instanceof Error) return value.stack ?? value.message
  return String(value)
}

let exitCode = 0
function fail(message) {
  exitCode = 1
  console.error('FAIL ' + message)
}
function pass(message) {
  console.info('ok   ' + message)
}

let mod
try {
  mod = await import(cordisSpec)
} catch (error) {
  fail('cannot import Cordis from ' + cordisSpec + ': ' + formatError(error))
  process.exit(1)
}

if (typeof mod.Context !== 'function') {
  fail('Cordis does not export Context')
  process.exit(1)
}

const plugin = await import(new URL('../index.js', import.meta.url).href)

// Shape the Cordis loader relies on.
if (typeof plugin.name !== 'string' || plugin.name.length === 0) fail('index.js has no `name` export')
else pass('host entry exports name = ' + plugin.name)
if (typeof plugin.apply !== 'function') fail('index.js has no `apply` export')
else pass('host entry exports apply()')
if (plugin.Config !== undefined) {
  fail('index.js must not export Config: Cordis validates it as a Standard Schema and a plain object throws at boot')
} else {
  pass('index.js exports no Config (Cordis passes the row config through unchanged)')
}
if (exitCode !== 0) process.exit(exitCode)

const ctx = new mod.Context()
let fiber
try {
  fiber = ctx.plugin(plugin)
  if (fiber !== null && typeof fiber === 'object' && typeof fiber.then === 'function') {
    await fiber
  }
} catch (error) {
  fail('ctx.plugin() rejected: ' + formatError(error))
}

await new Promise(resolve => setTimeout(resolve, 20))

if (!lines.some(line => line.includes('[dsh-alert] active'))) {
  fail('apply() did not reach its own "active" log; it either threw or was never called\n' + lines.join('\n'))
} else {
  pass('apply() mounted and logged activation')
}

// Drive the real emitter with realistic events. Subagent and bookkeeping events
// must stay silent; the two real ones must reach the notifier (dry-run: logged).
const main = { id: 'boot-check-main', header: { id: 'boot-check-main', cwd: 'C:/work/demo' } }
const child = { id: 'boot-check-child', header: { id: 'boot-check-child', origin: 'subagent', cwd: 'C:/work/demo' } }
const at = (type, seq, data) => ({ type, seq, time: 1_700_000_000_000, data })

// Topology matters, so model it exactly instead of using a root emit. In DSH the
// session store is a SIBLING plugin, and it publishes through
// `ctx.events.dispatch('emit', [carrier, 'session/event', session, event])`
// (see collectSessionCallbacks in packages/core/session/src/index.ts), where the
// carrier is a Scoped<Session> object. A plain `ctx.emit` on the root would pass
// even if a sibling-to-sibling subscription were impossible, which is exactly the
// failure this check exists to catch.
let storeCtx
const storePlugin = ctx.plugin({ name: 'boot-check-session-store', apply(storeContext) { storeCtx = storeContext } })
if (storePlugin !== null && typeof storePlugin === 'object' && typeof storePlugin.then === 'function') await storePlugin
await new Promise(resolve => setTimeout(resolve, 20))
if (storeCtx === undefined) {
  fail('could not mount the fake session store')
} else {
  pass('fake session store mounted as a sibling of the plugin')
}
const carrier = { name: 'boot-check-carrier' }
function emitSessionEvent(session, event) {
  const callbacks = storeCtx.events.dispatch('emit', [carrier, 'session/event', session, event])
  for (const callback of callbacks) callback(session, event)
  return callbacks.length
}

const delivered = emitSessionEvent(child, at('turn/end', 1, { turn: 1, reason: { kind: 'completed' } }))
if (delivered === 0) fail('the sibling dispatch collected no listeners; session events would never reach the plugin')
else pass('sibling dispatch collected ' + delivered + ' listener(s)')

emitSessionEvent(main, at('turn/end', 2, { turn: 2, reason: { kind: 'completed' } }))
emitSessionEvent(main, at('turn/end', 3, { turn: 3, reason: { kind: 'error', error: { message: 'boom' } } }))
emitSessionEvent(main, at('turn/end', 4, { turn: 4, reason: { kind: 'aborted', reason: { kind: 'user' } } }))
emitSessionEvent(main, at('compaction/end', 5, { compactionId: 'boot-check', turn: null }))

await new Promise(resolve => setTimeout(resolve, 20))

const dryRunAlerts = lines.filter(line => line.includes('dry-run'))
if (dryRunAlerts.length !== 3) {
  fail('expected 3 alerts (round, failed round, compaction), got ' + dryRunAlerts.length + '\n' + lines.join('\n'))
} else {
  pass('3 alerts raised, subagent and aborted rounds stayed silent')
}
if (errors.length > 0) fail('errors were logged during boot:\n' + errors.join('\n'))
else pass('no errors logged')

// A row config must reach apply() unchanged: this is the second mount, so it also
// proves teardown removed the first listener.
try {
  await fiber?.dispose?.()
} catch (error) {
  fail('disposal failed: ' + formatError(error))
}

const before = lines.filter(line => line.includes('dry-run')).length
const configured = ctx.plugin(plugin, { alertOnAborted: true, alertOnCompaction: false, titlePrefix: 'PROBE' })
if (configured !== null && typeof configured === 'object' && typeof configured.then === 'function') await configured
await new Promise(resolve => setTimeout(resolve, 20))
emitSessionEvent(main, at('turn/end', 6, { turn: 6, reason: { kind: 'aborted', reason: { kind: 'user' } } }))
emitSessionEvent(main, at('compaction/end', 7, { compactionId: 'boot-check-2', turn: null }))
await new Promise(resolve => setTimeout(resolve, 20))
const after = lines.filter(line => line.includes('dry-run')).length
if (after - before !== 1) {
  fail('the row config did not apply: expected 1 alert (aborted on, compaction off), got ' + (after - before))
} else {
  pass('row config applied: alertOnAborted on, alertOnCompaction off')
}
if (!lines.some(line => line.includes('PROBE · Round cancelled'))) {
  fail('the titlePrefix config was not used\n' + lines.join('\n'))
} else {
  pass('titlePrefix config reached the notification text')
}
try {
  await configured?.dispose?.()
} catch (error) {
  fail('second disposal failed: ' + formatError(error))
}

console.info = originalInfo
console.error = originalError
console.warn = originalWarn

if (exitCode === 0) console.log('\nboot check passed: the plugin mounts in a real Cordis context')
process.exit(exitCode)
