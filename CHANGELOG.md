# Changelog

## 0.3.0

The alert moved from the browser page to the Harness process. Nothing about the
install changes; the behaviour does.

**Why:** a hidden tab is throttled, can be frozen, and holds a `suspended` Web
Audio context, so a page-raised alert was silent until the user returned to the
tab — exactly when it was no longer useful. The Host already sees every round
boundary, so the alert is raised there.

- **Added** `index.js` as a real Host half: subscribes to `session/event` and maps
  `turn/end` (`completed`, `error`, `aborted`, `blocked`, `interrupted`, `forked`)
  and `compaction/end` to one desktop alert per committed event. Subagent sessions
  are filtered out by `session.header.origin`.
- **Added** `notifier.js`: Windows Action Center toast through PowerShell 5.1
  WinRT, `osascript` on macOS, `notify-send`/`paplay` on Linux. XML and AppleScript
  escaping, a spawn timeout, one warning per failure kind, and a stderr excerpt so
  a refused toast is diagnosable.
- **Changed** `client.js` to the tab-title mark only. It posts no notification and
  plays no sound, needs no permission, no user gesture, and opens no session
  stream (`inject` is just `remote`).
- **Fixed** duplicate alerts after a reload/HMR remount: the Host deduplicates per
  `sessionId`, event type, and `seq`.
- **Added** `tools/boot-check.mjs`: mounts the plugin in a real Cordis context.
- **Breaking** for anyone importing the package: the Host entry now exports
  `describeSessionEvent` / `applyWith` for tests, and exports **no `Config`** —
  Cordis validates `Config` as a Standard Schema and a plain object throws at boot.
- **Removed** the browser-side audio, notification permission handling, Web Lock
  keep-alive, and session-follow machinery.

## 0.2.0

First public release, from the private `alertone` plugin.

- Desktop notification plus a two-note tone when a round or compaction finishes or
  fails.
- Watcher moved off the conversation-header slot to the client root, so every
  attached session is observed.
- Durable per-session watermark so a reload cannot re-alert an old round.
- Subagent sessions stay silent.
