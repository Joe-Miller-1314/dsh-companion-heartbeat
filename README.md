# dsh-heartbeat

A small impulse engine for AI companions, packaged as a [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin.

Repository: <https://github.com/Joe-Miller-1314/dsh-heartbeat> · License: MIT · Node.js 20+

Most companion setups only react: a message arrives, the persona answers. `dsh-heartbeat` gives the persona a slow internal clock instead. Three needs — missing the other person, wanting company, being curious — rise quietly over time, get satisfied when the other person actually writes, and once in a while spike for no reason at all. Every few seconds the plugin asks one question:

> Does the persona want to say something right now, and how soon may it speak again?

The answer is written somewhere a host application can read: a plain JSON file, or the proactive-message switch of a chat host app. Nothing else is coupled to the plugin.

```text
needs ──► impulse ──► (suppression) ──► decision ──► adapter ──► your app
             ▲
        activity from the chat buffer (who spoke last, and when)
```

## What it does

- **Decides when to speak.** A decision per chat every tick, expressed as "allowed to speak in N minutes".
- **Feels like time passes.** Needs grow while nobody talks, drop when the other person answers, and decay after the persona itself speaks.
- **Has bad timing on purpose.** Bursts, follow-ups, quiet hours and a daily cap keep it from looking like a cron job.
- **Remembers the day (optional).** Once a week it asks a DSH session to turn the last day of chat into speaking habits, a few memories, and a short first-person narrative.
- **Watches one video now and then (optional).** Picks something from a public video API, remembers what it saw, and notes it in the persona file.

It needs no API key, no account and no database. State is a few JSON files in one directory.

## How a decision is made

Each tick (default every 10 s), per chat:

1. **Growth** — `miss += minutes × missRate`, likewise `social` and `curious`, clamped to 0..1. With a `burstChance` probability a sudden spike is added.
2. **Satisfaction** — if the buffer shows a new incoming message: `miss ×= 0.25`, `social ×= 0.35`, `curious −= 0.2`. If it shows a new *proactive* outgoing message: count it against the daily cap, `miss ×= 0.4`, `social ×= 0.5`, and possibly open a chatty window.
3. **Impulse** — `0.5 × miss + 0.3 × social + 0.2 × curious`.
4. **Suppression** — `+0.6` if the persona spoke less than 3 min ago, `+0.25` under 20 min, `+0.3` if it spoke and got no answer for 90+ min, `+0.5` if the other person is still typing-distance recent, `+1` during quiet hours.
5. **Decision** — speak when `(follow-up || burst || impulse − suppression > threshold ± noise)`, while idle long enough, after `gapMin`, and under the daily cap.

Speaking writes `speakIntervalMinutes` (default 2) as the allowed gap; staying quiet writes `holdIntervalMinutes` (default 1440). Both accept a `[min, max]` pair for jitter.

## Install

The package is a DSH bundle: `package.json` declares `dsh.bundle.patch`, and `cordis.patch.yml` inserts one plugin row.

1. Pack it — `npm pack` in this directory produces `dsh-heartbeat-1.0.0.tgz`.
2. Install the tarball as a bundle in DSH (Plugin Manager, or the equivalent `install_bundle` action), then enable it.

It also runs as an ordinary ES module — import `apply` and hand it a context with `on` / `effect`, which is what the smoke test does.

Node 20+ (uses global `fetch` and `AbortSignal.timeout`).

## Configuration

Every path, name and host-app detail is configuration; nothing about a particular machine is compiled in. Paths accept `~` and `${ENV_VAR}`.

```yaml
- insert:
    - id: heartbeat
      name: dsh-heartbeat
      config:
        persona: 'companion'
        dataDir: '~/.dsh/heartbeat'
        chats: ['demo']
        rolePath: '~/my-app/roles/companion.md'
        bufferPath: '~/my-app/state/messages.json'
        tickSeconds: 10
        adapter:
          type: json
          path: '~/my-app/state/proactive.json'
        quietStart: 0            # shorthand: top-level tuning keys are merged too
```

| Key | Default | Meaning |
| --- | --- | --- |
| `persona` | `companion` | Display name; used in the consolidation prompt. |
| `dataDir` | `~/.dsh/heartbeat` | Where state, log, tuning and memories live (`$DSH_HOME` respected). |
| `chats` | `[]` | Chat keys to track. Empty means "ask the adapter" (the wechatagent adapter reads its whitelist). |
| `rolePath` | — | Persona markdown file. Gets the `NOW` / `LEARNED` / `WATCHED` blocks. Optional. |
| `bufferPath` | — | JSON message buffer used to read activity. Optional: without it the persona is simply always idle. |
| `bufferFormat` | `auto` | `auto` understands `outgoing`, `isSend: 1` and `message_id: "out-…"`. |
| `tickSeconds` | `10` | Decision interval, minimum 1. |
| `tuning` | see below | Numbers for the decision engine. |
| `adapter` | `{ type: 'json' }` | Where the decision goes — see below. |
| `life.enabled` | `true` | Refresh the "what I am doing right now" block. |
| `life.slots` / `life.file` | built-in | Replace the rotation of daily scenes (same shape: `[{from,to,items:[[tag,text]]}]`). |
| `life.minMinutes` / `maxMinutes` | `100` / `180` | Random pause between scene changes. |
| `life.template` | `Now: {text}\nMood: {tag}` | Text inside the `NOW` block. |
| `consolidate.enabled` | `true` | Weekly memory pass. |
| `consolidate.intervalHours` | `168` | Missed runs are caught up on the next tick. |
| `consolidate.sessionId` | `heartbeat-memory` | DSH session used for the prompt. Created on demand. |
| `consolidate.cwd` | process cwd | Working directory for that session. |
| `consolidate.promptFile` | — | Replace the built-in prompt (`{{persona}}`, `{{life}}`, `{{habits}}`, `{{said}}`, `{{heard}}`). |
| `watch.enabled` | `false` | Occasional video. |
| `watch.intervalMinutes` | `150` | Minimum gap. |
| `watch.hours` | `[9, 1]` | Allowed hours, wraps midnight. |
| `watch.interests` | broad list | Keywords that rank candidate videos. |
| `watch.credentialPath` | — | Optional local credential JSON (`sessdata`, `bili_jct`, `buvid3`, `dedeuserid`). Anonymous calls work without it. |

### Live tuning

On first run the engine writes its numbers to `<dataDir>/config.json` and re-reads that file every tick. Edit it to change the mood without restarting DSH:

```json
{ "missRate": 0.026, "threshold": 0.16, "dailyCap": 20, "quietStart": 1, "quietEnd": 7 }
```

Lower `threshold` or raise `missRate` for a clingier persona; the opposite for a distant one.

### Touch files

`<dataDir>/consolidate-now` triggers a memory pass on the next tick; `<dataDir>/watch-now` triggers a video. Both are deleted after use.

## Adapters

| Type | Behaviour |
| --- | --- |
| `json` (default) | Writes `{ updatedAt, chats: { key: { allowed, intervalMinutes, decision } } }` to `adapter.path`. Good for any app, and for trying the plugin without a host app. |
| `wechatagent` | Updates only the `wechat.proactive` block of a chat host config (`enabled`, `intervalMinutes`, `idleMinutes`, `jitterMinutes`, `startTime`, `endTime`, `mode`, per-chat allow list). Every other key in that file is left untouched. Keys come from `chats`, or from `wechat.whitelist.private/groups` when `chats` is empty. |
| `module` | `adapter.module` points at a JS file exporting `apply(plans, decisions, options)`. |

## Data files

```text
<dataDir>/
  state.json          needs, per-chat counters, last decision, current scene
  config.json         live tuning values
  heartbeat.log       one line per tick, rotated at 512 KiB
  consolidate.json    last memory pass
  watch.json          seen videos
  proactive.json      json adapter output
  memory/
    memories.json
    self-narrative.md
```

The persona file, when configured, gets three replaceable blocks: `<!-- HEARTBEAT:NOW -->`, `<!-- HEARTBEAT:LEARNED -->`, `<!-- HEARTBEAT:WATCHED -->`. Each is rewritten in place, so hand-written personality text around them survives.

## Notes on the design

- **Why needs instead of a timer.** A fixed interval produces a heartbeat nobody believes. Growing needs with suppression mean the same code can be clingy in one chat and quiet in another without retuning.
- **Why thresholds are noisy.** `thresholdNoise` makes the same internal state produce different outcomes, which is what "almost said something" looks like from outside.
- **Why the engine is pure.** `lib/engine.js` has no I/O: it mutates the state it is handed. The tick is therefore testable without waiting for wall-clock time.
- **Why adapters.** The interesting part is the decision, not the integration. Keeping the integration small is what makes the plugin portable.

## Limitations

- **It does not send messages.** It only writes a decision; your host app has to honour it.
- **Memory quality depends on the model.** Consolidation asks for strict JSON and is tolerant but not infallible; a malformed reply is logged and skipped.
- **Consolidation needs `sessionController`.** The plugin declares no hard service dependencies (`inject = []`), so it loads in any profile; only the weekly memory pass needs that service. Without it the pass logs `sessionController unavailable` and skips itself, everything else keeps running.
- **The weekly pass is not per-chat.** It merges everything in the buffer across chats.
- **Video watching targets bilibili's public web APIs.** Rates, regions and availability can change without notice.
- **No UI.** State is inspectable as JSON; there is no dashboard.

## Disclaimer

Automating a chat platform, and reading a local signed-in cookie file, may conflict with that platform's terms of service. This plugin ships no credentials and no account data, and the video feature works anonymously by default. Use it on accounts you own and at your own risk. The bundled daily scenes are generic placeholders, not a persona.

## Development

```bash
node test/smoke.mjs
```

The suite covers the engine, config resolution, activity parsing, both adapters, the life block, one end-to-end tick, and a scan that no machine-specific path or name leaked into the sources.

## License

MIT. See [LICENSE](LICENSE).

## 中文简介

给陪伴型人格装一颗"心跳"：三条需求（想念 / 想有人陪 / 好奇）随时间缓慢上涨，对方回话就被满足，偶尔毫无理由地跳一下。每隔几秒算一次"此刻想不想开口、多久后可以再开口"，结论交给适配器——可以是一个普通 JSON 文件，也可以是聊天宿主应用里的主动发言开关。

所有路径、人格名、宿主应用细节都来自配置，代码里没有绑定任何一台机器。数据只有 `<dataDir>` 下的几个 JSON 文件。可选功能：每周把一天的聊天沉淀成说话习惯与记忆；偶尔刷一条视频记下来。默认不发任何消息，只做决定。
