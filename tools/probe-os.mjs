// Real desktop probe: send one notification through the actual OS path.
//
// This is the only check that proves the notification reaches your desktop. It
// runs on purpose rather than in `npm test`, because it pops a real toast.
//
//   node tools/probe-os.mjs            # one "round complete" alert
//   node tools/probe-os.mjs --failed   # the failure variant (different sound)
//   node tools/probe-os.mjs --quiet    # no sound
//
// Exit code 0 means the helper program was started; 1 means this platform has no
// notifier (the reason is printed). A started program that Windows then suppresses
// (Focus Assist, notifications off) looks identical to success here — check your
// notification centre.

import { createNotifier } from '../notifier.js'

const args = process.argv.slice(2)
const failed = args.includes('--failed')
const sound = !args.includes('--quiet')

const notifier = createNotifier()
const alert = {
  title: 'DSH · ' + (failed ? 'Round failed' : 'Round complete'),
  body: 'dsh-alert probe · ' + (failed ? 'failure variant' : 'success variant') + ' · sound ' + (sound ? 'on' : 'off'),
  failed,
}

const started = notifier.send(alert, { notify: true, sound })

console.log('platform:', notifier.platform)
console.log('alert:   ', alert.title, '—', alert.body)
console.log('started: ', started)

if (!started) {
  console.error('no OS notifier was started on this platform; see the warning above')
  process.exit(1)
}

// Give the helper process time to show the toast before this script exits.
await new Promise(resolve => setTimeout(resolve, 2500))
console.log('done: check your notification centre (and the tray on Windows)')
