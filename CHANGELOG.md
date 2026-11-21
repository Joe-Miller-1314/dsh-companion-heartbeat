# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.2] - 2026-11-21

### Fixed

- The local panel answered `Access-Control-Allow-Origin` only for `http://`
  loopback pages, but the desktop app renders from the `dsh-app://app` scheme, so
  the in-app list could not read it. That origin is now trusted as well; the
  standalone page still needs its token.
- The in-app card shows the fetch error and its own origin when it cannot reach
  the host, instead of only guessing.

## [1.4.1] - 2026-11-21

### Fixed

- The client half registered into `settings.plugin.item`, a slot this DSH
  release does not declare, so nothing showed up in the GUI. It now claims its
  own page in Settings through `settings.section` (id `companion-heartbeat`),
  with a localized nav label from the plugin's own dictionary.

## [1.4.0] - 2026-11-21

### Added

- `dshim` adapter: delivers the decision through
  [@xmanrui/dsh-im](https://github.com/xmanrui/dsh-im). The plugin composes one
  short line (`session` mode asks the session service, `template` mode fills a
  string) and POSTs it to the host's `/api/dsh-im/delivery/messages`, with an
  adapter-side `minGapMinutes` floor and send times persisted to
  `dshim-delivery.json`.

## [1.3.0] - 2026-11-21

### Added

- Client half: the "Keep in mind" list now also renders inside DeepSeek Harness,
  as a card on the plugin's own settings page (`settings.plugin.item` slot). The
  card reads and writes the same host endpoints as the standalone page.

### Changed

- The local panel accepts requests whose `Origin` is a loopback page, so the GUI
  can talk to it without reading `panel-token.txt`. The token still guards the
  standalone URL and keeps other local programs out.

## [1.2.0] - 2026-11-15

### Changed

- Renamed the npm package to `dsh-companion-heartbeat`: `dsh-heartbeat` was
  already taken on npm by an unrelated scheduling plugin, and a name clash would
  make the two indistinguishable in the plugin market. The plugin row id stays
  `heartbeat`, so existing `cordis.patch.yml` configuration keeps working.

## [1.1.0] - 2026-11-15

### Added

- Local settings page ("who to keep in mind"): lists the adapter's chats and the
  chats that have messages in the buffer, with names and last activity, lets the
  user tick the ones the heartbeat may reach out to, and saves the choice to the
  live tuning file. Bound to `127.0.0.1`, guarded by a per-install token.
- `panel.enabled` and `panel.port` configuration keys; the page URL is written to
  `heartbeat.log` and the token to `<dataDir>/panel-token.txt`.

### Changed

- An explicit `chats` list in the tuning file (including an empty one) now wins
  over the adapter's own guess, so the page's selection takes effect on the next
  tick without a restart.

## [1.0.0] - 2026-11-14

First public release. Rewritten from a single-machine private plugin into a
configurable bundle; the decision numbers are unchanged, so the behaviour is the
same as the version it replaces.

### Added

- Decision engine as a pure module: three needs grow over time, are satisfied by
  activity, and are suppressed by recent speech, quiet hours and a daily cap.
- Configuration for every path, name and host-app detail, with `~` and `${ENV}`
  expansion and a live tuning file re-read on every tick.
- Three adapters: `json` (no host app needed), `wechatagent` (writes only the
  proactive block of a chat host config) and `module` (external `apply` hook).
- Optional "what I am doing right now" block, weekly memory consolidation, and
  occasional video watching; each can be disabled and each is configurable.
- `README.md`, MIT `LICENSE`, English and Chinese locale metadata, an icon, and
  a smoke test covering the engine, configuration, adapters and one live tick.

### Changed

- Split the monolithic host module into `index.js` plus small `lib/` modules.
- Replaced hard-coded intervals with `speakIntervalMinutes` and
  `holdIntervalMinutes`, so the same engine can be clingy in one chat and quiet
  in another.
- Replaced the bundled daily scenes with neutral placeholders that users can
  substitute through `life.slots` or `life.file`.

### Removed

- Absolute paths, personal names, session identifiers and the chat allow list
  that were compiled into the private version.
- Dead code that was never reached (`pickInterval`, `greetingShare`,
  `followUpInterval`, the `interval*` tables).
- Build artifacts (`dist/*.tgz`) and editor backups from the source tree.
