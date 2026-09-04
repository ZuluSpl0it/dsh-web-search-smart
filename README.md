# dsh-web-search-smart

Keyless web-search provider for the DeepSeek Harness (`dsh-web` seam, provider id **`smart`**).

Query **Google, Bing and DuckDuckGo in parallel**, merge with reciprocal rank fusion, discard
bot-feed/degraded engine sets (they go to cooldown instead of reaching you), and optionally run
one short local-model turn (this deployment: local qwen) to rank the merged candidates and write
the summary `answer` the `web_search` tool renders.

Design: [`docs/2026-09-04-dsh-web-search-smart-design.md`](docs/2026-09-04-dsh-web-search-smart-design.md).

## Why it exists

The community `dsh-web-search-local` plugin (a) returns the first engine that produced anything,
(b) has no detection of degraded/bot SERPs, and (c) silently ignores `google` in `engines`
(no such engine is implemented). On a datacenter-ish IP Bing serves randomized garbage feeds
("Content was generated with AI"), which that plugin passed through verbatim.

## Installation

From a fresh `dsh` install to a working `web_search`.

### 1. Prerequisites

- `dsh` is installed and at least one profile exists under `~/.dsh/profiles/` (the `web` profile auto-initializes on first `dsh web` use; this install targets it).
- The shared `~/.dsh/profiles/node_modules` (or any ancestor `node_modules` of the clone path) contains `@deepseek-ai/dsh-web` and `@deepseek-ai/schemastery` — both ship inside a `dsh` install tree.
- *Optional* — for the LLM rank/summary step: the configured LLM route is up (default `qwen-local` → `http://127.0.0.1:18020/v1` in `~/.dsh/settings.yaml`, with `QWEN_LOCAL_API_KEY` set). If it is down or misconfigured the step fails closed and the deterministic RRF order is used instead; search itself never blocks on the model.

### 2. Clone

```sh
git clone https://github.com/ZuluSpl0it/dsh-web-search-smart ~/.dsh/profiles/web/plugins/dsh-web-search-smart
```

The path matters: the plugin's bare imports (`@deepseek-ai/dsh-web`, `@deepseek-ai/schemastery`) resolve by walking up from the entry file, so keep it under `~/.dsh/profiles/` where the shared `node_modules` sits. A local copy works too (`cp -r` into the same directory) — there is no published package.

### 3. Wire the profile

Edit **`~/.dsh/profiles/web/cordis.patch.yml`** (the profile's user patch layer — *not* `cordis.yml`, which is an empty, comment-only entry list):

```yaml
- id: web
  config:
    searchProvider: smart     # this plugin's provider id
    # fetchProvider: local-fetch   # independent; keep whatever you already have

- id: web-search-deepseek
  disabled: true              # avoid two live search providers

- insert:
  - id: web-search-smart
    name: 'file:///home/sofoli/.dsh/profiles/web/plugins/dsh-web-search-smart/index.js'
```

Quote the `file://` URL (the colons) and use an absolute path to *your* clone location.

### 4. Restart

Module loading requires a `dsh` restart; start it again:

```sh
dsh web            # or: dsh --profile web
```

Config fields under `Settings > Plugins > Plugin configuration > web-search-smart` hot-reload after that (the profile runs `patchReload: live`).

### 5. Sanity check (no dsh needed)

```sh
cd ~/.dsh/profiles/web/plugins/dsh-web-search-smart
node scripts/selftest.mjs "RTX 3090 VRAM gigabytes"
```

Prints each engine's verdict (`ok` / `blocked` / `degraded` / `error`), its top results, and the RRF merge. If an engine reports `blocked` or `degraded` here, expect the matching cooldown in the live tool until it expires.

### 6. First search

Ask the agent to search (e.g. "search the web for …"), or check the `web_search` result card in the GUI. The LLM step's decision path (used/fallback/skip, with reason) is traced to `plugins/diag.log` next to this repo.

## Behavior

- Each engine returns a verdict: `ok`, `blocked` (captcha/consent/anomaly → 60 min cooldown),
  `degraded` (bot-feed markers, domain floods, language mismatch, markup change → 10 min cooldown),
  or `error`.
- Healthy sets merge with RRF (k=60); a URL seen in two engines outranks one seen in one.
- Language gate drops result sets that are ≥60% the wrong script family for the query.
- LLM step (configurable, on by default): strict-JSON rank + 2–4 sentence answer with `[n]`
  citations; any failure falls back to deterministic RRF order — search never blocks on the model.
- 5-minute in-memory result cache; cooldowns and cache are per-process (reset on dsh restart).

## Wiring (already in `~/.dsh/profiles/web/cordis.patch.yml`)

```yaml
- id: web
  config:
    searchProvider: smart
```

plus an `insert` row pointing at this repo's `index.js`. One dsh restart loads the module;
config changes after that hot-reload (Settings → Plugins → Plugin configuration → *web-search-smart*).

## Config

| field | default | notes |
|---|---|---|
| `engines` | `google, bing, duckduckgo` | order = RRF tie-break preference |
| `locale` | `en` | feeds hl/gl/kl/setlang/cc |
| `userAgent` | modern Chrome | |
| `proxyUrl` | `off` | v1: `"off"` only |
| `searchTimeoutMs` | 10000 | per engine |
| `llmRanking` | `true` | |
| `llmProvider` / `llmModel` | `qwen-local` / `qwen3.8-27b` | any `ctx.llm` route |
| `llmTimeoutMs` | 15000 | |
| `llmMaxCandidates` | 12 | candidates sent to the model |
| `maxSources` | 12 | pre-seam cap |
| `cacheTtlMs` / `cacheMax` | 300000 / 200 | |

## Self-test (no dsh needed)

```sh
node scripts/selftest.mjs "your query here"
```

Runs the engines and merge straight from this machine and prints per-engine verdicts,
top results, and the RRF merge.

## Extending

Add a file in `engines/` exporting `search(query, cfg, signal)` returning a verdict, register it
in `ENGINES` in `index.js`, and add its name to the config `engines` list.

## License

MIT.
