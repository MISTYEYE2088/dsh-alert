# dsh-alert

A DeepSeek Harness web plugin that tells you when the agent is done.

When an agent round finishes, fails, or a context compaction completes, `dsh-alert`
posts a system notification, plays a short two-note tone, and marks the tab title
while the tab is in the background — so you can leave the page and still be told
when your agent needs you again.

```text
round complete   ✓  rising two-note tone   · notification "DSH · Round complete"
round failed     ✗  falling two-note tone  · notification with the error message
context compacted  ✓  rising tone          · notification "DSH · Context compacted"
```

Nothing leaves your machine: no network calls, no telemetry. The plugin only reads
session events the Harness already sends to the browser.

---

## Requirements

- A DeepSeek Harness **source checkout** running the **web** profile
  (`pnpm dsh web`), version `0.2.0-rc.2` or compatible.
  The `npx`/registry install cannot load out-of-tree plugins.
- A Chromium-based browser or Firefox on the same machine.
- Node 22.19+ or Node 24+ for the checkout itself (the plugin adds no dependencies).

## Install

```powershell
# 1. Clone somewhere stable (this directory becomes the plugin package)
git clone https://github.com/MISTYEYE2088/dsh-alert.git C:\portable_software\dsh\dsh-alert

# 2. Install it into the web profile (this forwards to pnpm inside the profile
#    and adds the row to the profile's bundle list)
cd C:\portable_software\dsh\deepseek-harness
pnpm dsh plugin --profile web add C:\portable_software\dsh\dsh-alert

# 3. Restart the web server: a new plugin row is a host-tree change
pnpm dsh web
```

Then open the token URL the server prints and reload the page.

### Manual install (if `dsh plugin add` is unavailable)

`~/.dsh/profiles/web/package.json` must name the plugin in both places:

```jsonc
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-alert"]
    }
  },
  "dependencies": {
    "dsh-alert": "link:C:\\portable_software\\dsh\\dsh-alert"
  }
}
```

Then run `pnpm install` inside `~/.dsh/profiles/web` and restart the web server.
The plugin's own `cordis.patch.yml` inserts the row; the bundle list is what makes
the Harness read that file.

## First run: arm sound and notifications

Browsers only allow a page to resume audio and to ask for notification permission
**in response to a user gesture**. `dsh-alert` therefore arms itself on your first
click or keypress inside the page, and prints what it got:

```text
[dsh-alert] active 0.2.0 { audio: 'suspended', notification: 'default', keepalive: true }
[dsh-alert] audio armed
[dsh-alert] notification permission = granted
```

Click once anywhere in the page and both lines appear. If you never click, the
notification is still attempted but the browser will refuse the permission prompt.

You can also arm it by hand from the browser console:

```js
dshAlert.arm()      // request permission + resume audio
dshAlert.status()   // current state: audio, permission, watched sessions, alerts
dshAlert.test(true) // fire a sample failure alert right now
```

## Verify that it works

1. Open the browser console and confirm `[dsh-alert] active 0.2.0`.
2. Run `dshAlert.test()` — a notification and a tone should follow.
3. Send a real prompt, switch to another window, wait for the round to end, and
   confirm the notification arrives **while the tab is in the background**.

If step 3 only fires when you come back to the tab, read
[Background tabs](#background-tabs-what-is-guaranteed) before filing a bug.

## Background tabs: what is guaranteed

This is the part that used to be unreliable, and browsers make it a real
constraint rather than a bug in the plugin.

Nothing in the Harness stops sending session events to a hidden tab: `running`
arrives on the existing WebSocket push and the session store flushes on
microtasks, so no data is lost when the page is in the background. What fails is
page-side scheduling — work queued on `requestAnimationFrame` never runs in a
hidden tab, and chained `setTimeout` calls get clamped to once a minute. The 0.2.0
rewrite therefore schedules nothing on a frame, keeps its one fallback timer a
single fresh timeout, and adds the mitigations below.

| Situation | What `dsh-alert` does |
| --- | --- |
| Tab visible, alert fires | notification + tone, immediately |
| Tab hidden, page still running | notification + tone, immediately |
| Tab hidden, Chrome *froze* the page | nothing can run; the alert fires the moment the page resumes, once, with the tab-title mark restored |
| Several rounds finish while you are away | one alert per round, no duplicates |
| Page reloaded or HMR re-ran the plugin | no alert for a round you were already told about |

What the plugin does to keep the hidden tab alive and audible:

- **Arms audio on your first gesture.** A Web Audio context created without a
  gesture stays `suspended`, and tones scheduled against it are heard only when it
  resumes — which is exactly when you return to the tab. That was the original
  "it only beeps when I refocus" symptom.
- **Never queues tones on a suspended context.** A silent alert stays silent and
  says so in the console, instead of becoming a startle when you come back.
- **Holds a Web Lock while hidden with work in flight.** Chrome does not freeze
  pages that hold one. The lock is released the moment the tab is visible again or
  nothing is running, so an idle tab costs nothing.
- **Marks the tab title** (`(2) DeepSeek Harness`) while alerts are unread, and
  restores it when you return.
- **Reconciles on every resume path** — `visibilitychange`, `focus`, `pageshow`,
  `resume`, and a Harness `connection/reset` — against a durable per-session
  watermark, so an edge that was missed while frozen is still reported once.

If your browser still freezes the tab, the alert is delivered on return. To avoid
that, keep the tab in its own window (or exclude the origin from your browser's
memory saver). `dshAlert.keepalive(false)` disables the Web Lock.

### Why not a service worker or Web Push?

The "notify me even with no page open at all" trick is the Push API plus a service
worker: the site registers a push subscription, an external push service (FCM,
Mozilla autopush) wakes the worker, and the worker shows the notification. It is
the wrong tool here:

- the subscription is bound to an external push service with VAPID keys and an
  internet path, while a Harness web profile is a machine-local server;
- it solves "no page is open", not this plugin's problem, which is "the page is
  open but the browser is throttling it";
- it still needs the user's explicit permission, and a plugin that asks for a
  permanent push channel in order to beep on localhost deserves the suspicion that
  pattern has earned.

If you need a signal that is independent of the browser tab, the *Host* half of a
plugin can subscribe in Node to `agent/status`, `agent/error`, or `session/event`
and filter `turn/end` (whose `data.reason` carries `completed` / `error` /
`aborted`), then raise an OS notification. That works even when the tab is frozen
or closed. `dsh-alert` stays in the browser so the alert follows the tab you are
actually using; open an issue if you want the Host-side channel as an option.

## How it works

`dsh-alert` has no UI and no React: it subscribes to the session events the
Harness forwards to every browser client, at the client root, once per page load.

| Event | Used for |
| --- | --- |
| `api-session/added` | session identity, `origin` (subagent vs main), working directory |
| `api-session/status` | the running → idle edge that fires an alert |
| `api-session/error` | why the round is failing, shown in the notification |
| `api-session/removed` | drop that session's watcher and state |
| `session.follow` snapshot/stream | `compaction/start`/`compaction/end`, and the `turn/end` reason |
| `connection/reset` | re-open the follow streams after a reconnect |

Each session's progress is recorded in `localStorage` under
`dsh-alert/v1/marks` (`turnSeq`, `compactSeq`, plus the time of the last report).
That watermark is what makes alerts exactly-once:

- a live `turn/end` reports the round with its real outcome;
- the status edge is a 500 ms fallback for a session with no usable stream;
- a follow snapshot that reconnects is compared against the watermark, so a
  replayed tail never alerts twice, while a round that finished during a freeze is
  still reported;
- the first time a session is ever seen, its tail is adopted as a baseline instead
  of being announced, so opening the app never replays yesterday's rounds.

Subagent sessions are ignored: a spawned worker finishing is not your turn.

## Troubleshooting

Open the browser console; every decision is logged under `[dsh-alert]`.

| Symptom | Cause and fix |
| --- | --- |
| No `[dsh-alert] active` line | The plugin row is not composed. Re-run `dsh plugin --profile web add <path>`, restart `pnpm dsh web`, reload with a fresh token URL. |
| `notification permission is default` | The permission prompt was never raised by a gesture. Click once in the page, or call `dshAlert.arm()`. |
| `notification permission is denied` | Site settings blocked it: allow notifications for `127.0.0.1:3080` and reload. The tone still works. |
| `audio is still suspended` | Same gesture requirement. Click once inside the page. |
| `a hidden tab may be frozen` / `navigator.locks unavailable` | The page is not a secure context or the browser lacks Web Locks; keep-alive is off, alerts still work while the page runs. |
| `status for an unknown session …` | The Host never announced that session, so the plugin cannot tell a main session from a subagent and stays quiet. Reload with a fresh token URL; report it if it persists. |
| Alert arrives only after you return to the tab | The tab was frozen or the alert fired before your first gesture. See [Background tabs](#background-tabs-what-is-guaranteed). |
| Two alerts for one round (older versions) | Fixed in 0.2.0 by the watermark; if you see it, run `node tools/smoke.mjs` and include the output. |

To silence it temporarily, remove the row or run `dsh plugin --profile web remove dsh-alert`
followed by `pnpm install` in the profile and a restart.

## Development

```powershell
node --check client.js     # client.js must parse as a classic script
node tools/smoke.mjs       # 13 scenarios: one alert per round, replays, catch-up,
                           # subagents, gesture arming, keep-alive lock, compactions
```

`client.js` is **not** an ES module. The Host concatenates every plugin's client
artifact into one classic `<script>` response, so a single top-level `import` or
`export` breaks the whole batch with a `SyntaxError` that the boot error blames on
an unrelated module. Keep the file as one
`window.__ModuleLoader__.load({ id, factory })` registration, and keep the logic
inside the factory.

The smoke harness runs the real `client.js` against a hand-built browser
(`Notification`, `AudioContext`, `localStorage`, a controllable `document.hidden`)
and a fake Cordis context, then asserts how many alerts each sequence produces. It
does **not** prove that your browser will deliver a notification or play a tone —
only a real page can prove that.

## License

[MIT](LICENSE).

`dsh-alert` started as a private plugin called `alertone`, built and debugged with
the DeepSeek Harness plugin guide; the 0.2.0 rewrite fixes the "only alerts when I
come back to the tab" and duplicate-alert behaviour described above.
