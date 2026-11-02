# dsh-alert

Desktop notifications and a sound for DeepSeek Harness — raised by the **Harness
process**, not by a browser tab.

When an agent round finishes, fails, or a context compaction completes,
`dsh-alert` pops a native notification and plays the system notification sound.
It keeps working with no browser tab open, ten tabs open, a background tab the
browser throttled, and a tab that was closed an hour ago.

| Event | Alert |
| --- | --- |
| Round completed | "DSH · Round complete" + notification sound |
| Round failed | "DSH · Round failed" + the error message |
| Context compacted | "DSH · Context compacted" |
| Compaction failed | "DSH · Compaction failed" + the error message |
| Round cancelled by you | silent by default (`alertOnAborted` turns it on) |
| Subagent round | always silent |

Nothing leaves your machine: no network calls, no telemetry, no push service.

---

## Why the Host process

Notifications used to come from the page, which meant the page had to be awake,
audible, and allowed to beep. That is exactly what a background tab is not: a
hidden tab is throttled, may be frozen outright, and a Web Audio context stays
`suspended` until a user gesture, so tones queued in the background were heard
only on return to the tab.

The Harness already emits every round boundary to the Host process, so the alert
is raised there instead:

- one alert per round, no matter how many tabs are open (a single process sees
  each committed event once);
- background, frozen, or closed tabs change nothing;
- no notification permission prompt, no autoplay policy, no user gesture — a
  process is not a page.

The browser half still does the one thing only a page can: it counts finished
rounds in the tab title so a returning user sees what happened while away.

## Requirements

- A DeepSeek Harness **source checkout** running the **web** profile
  (`pnpm dsh web`), version `0.2.0-rc.2` or compatible.
  A registry (`npx`) install cannot load out-of-tree plugins.
- Node 22.19+ or Node 24+ for the checkout. The plugin adds **no dependencies**.
- Windows 10/11, macOS, or Linux — see [Platforms](#platforms).

### Compatibility notes

- **No `peerDependencies` are declared**, deliberately: the Host half imports
  nothing from DSH (only `node:` built-ins), and DSH range-checks any peer against
  the running version — declaring one would make every future DSH release need a
  manual `dsh plugin allow-version` exemption. A package with no peers is never
  blocked by the compatibility preflight.
- **No `Config` export**, deliberately: see [Development](#development).
- **No build step.** Unlike a TypeScript plugin that ships `lib/`, the source here
  *is* the artifact, so what you read is what the loader imports.
- `client.js` imports nothing either; it is served as one plain classic script.

## Install

```powershell
# 1. Clone somewhere stable
git clone https://github.com/MISTYEYE2088/dsh-alert.git C:\portable_software\dsh\dsh-alert

# 2. Install it into the web profile
cd C:\portable_software\dsh\deepseek-harness
pnpm dsh plugin --profile web add C:\portable_software\dsh\dsh-alert

# 3. Restart: a new plugin row is a host-tree change
pnpm dsh web
```

The Host half takes effect on that restart; the browser half is picked up when
you reload the page.

### Manual install

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

## Verify

The Host half announces itself in the server log:

```text
[dsh-alert] active { platform: 'win32', notify: true, sound: true, compaction: true, aborted: false }
```

Send yourself one real notification without an agent round:

```powershell
cd C:\portable_software\dsh\dsh-alert
node tools/probe-os.mjs            # success variant
node tools/probe-os.mjs --failed   # failure variant, different sound
```

Then run a real prompt and switch to another window — the notification should
arrive while the tab is untouched.

## Configuration

Options are Cordis row config. Set them on the plugin row in your profile patch
(`~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- id: dsh-alert
  name: dsh-alert
  config:
    sound: false
    alertOnCompaction: false
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch; `false` mounts nothing |
| `notify` | `true` | Show the desktop notification |
| `sound` | `true` | Play the notification sound |
| `alertOnCompaction` | `true` | Announce context compaction |
| `alertOnAborted` | `false` | Announce rounds you cancelled yourself |
| `titlePrefix` | `"DSH"` | Prefix of the notification title |

`DSH_ALERT_DRY_RUN=1` in the server environment logs what would be announced
instead of touching the desktop — useful when testing a profile.

## How it works

The Host half subscribes to `session/event`, the post-commit append feed of every
session log, filters the two events that mean something to a user, and hands the
text to `notifier.js`:

| Session event | `data` | Decision |
| --- | --- | --- |
| `turn/end` | `reason.kind: 'completed'` | announce "Round complete" |
| `turn/end` | `reason.kind: 'error'` (`error.message`) | announce "Round failed" + message |
| `turn/end` | `reason.kind: 'aborted'` | silent unless `alertOnAborted` |
| `turn/end` | `'blocked'`, `'interrupted'`, `'forked'` | silent — the turn never ran, or the log closed it on resume/fork |
| `compaction/end` | `error?: string` | announce compacted / failed |

Every session is filtered by `session.header.origin`: `'subagent'` sessions are
skipped, so a spawned worker finishing never pings you. Alerts are deduplicated
per session id, event type, and `seq`, so one committed event produces one
notification even if the loader re-applies the plugin.

### The browser half

`client.js` listens to `api-session/added` / `api-session/status` /
`api-session/error` and, while the tab is hidden, prefixes the tab title with the
number of finished rounds (`(2) DeepSeek Harness`), restoring it when you return.
It posts no notification and plays no sound — that would double every Host alert.
It needs no permissions and no user gesture.

## Platforms

| Platform | Notification | Sound |
| --- | --- | --- |
| **Windows 10/11** | PowerShell 5.1 + `Windows.UI.Notifications` toast → Action Center | the toast's own notification sound; a system sound if the toast API fails |
| **macOS** | `osascript -e 'display notification …'` | `sound name Glass` / `Basso` |
| **Linux** | `notify-send` | `paplay` with a freedesktop sound, if installed |
| anything else | log only, with one warning | none |

Windows shows the toast under **PowerShell's** registered AppUserModelID: Windows
only renders a toast for an AUMID that a Start-menu shortcut owns, and a plugin
must not install shortcuts behind your back. The toast body is still the alert
text. Focus Assist, notification settings, and a muted system sound can all
suppress it — that is a Windows setting, not a plugin failure.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| No `[dsh-alert] active` line in the server log | The row is not composed. Re-run `dsh plugin --profile web add <path>`, restart `pnpm dsh web`. |
| `[dsh-alert] … exited with 1: …` | The OS helper refused. On Windows the message is the toast API's own text; on Linux install `notify-send` / `libnotify-bin`. |
| `no OS notifier for platform …` | Unsupported OS: alerts are log-only. Open an issue. |
| Toast appears but the sound does not | Windows notification sound is muted in Settings → System → Notifications. |
| No notification while a round ends | Check `enabled` / `notify` in the row config, and that the round actually committed a `turn/end` (a cancelled round is silent by default). |
| Subagent rounds are silent | By design. |
| Tab title shows `(1)` after you return | The mark clears on the next `visibilitychange`/focus; call `dshAlert.clear()` in the console to force it. |

Removing the plugin: `dsh plugin --profile web remove dsh-alert`, then
`pnpm install` in the profile directory and restart.

## Development

```powershell
node --check index.js && node --check notifier.js && node --check client.js
npm test          # 27 scenarios: event mapping, config, escaping, title mark
npm run test:boot # mount in a REAL Cordis context (needs a DSH checkout)
npm run test:os   # one real desktop notification
```

`npm run test:boot` is the important one. The DSH loader treats a plugin that
cannot be imported or applied as a **fatal startup error**, so a malformed row
costs the user their whole profile instead of one missing feature. The check boots
the plugin inside a real Cordis `Context`:

```powershell
node tools/boot-check.mjs "C:\portable_software\dsh\deepseek-harness\node_modules\@deepseek-ai\cordis"
```

It already earned its keep: an exported `Config` object of defaults — the natural
thing to write — makes Cordis call `Config["~standard"].validate(...)` and throw,
which would have stopped the profile from booting. This package therefore exports
**no `Config`** and merges the row config itself. Keep it that way, or export a
real Standard Schema.

`client.js` must stay a **classic script**: the Host concatenates every client
artifact into one `<script>` response, so one top-level `import`/`export` breaks
the whole batch with a `SyntaxError` that the boot page blames on another module.

## License

[MIT](LICENSE).

Started as a private plugin (`alertone`) that alerted from the browser page; 0.3.0
moved the alert to the Host process so it no longer depends on a tab being awake.
