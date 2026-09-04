# dsh-web-search-smart — Design Spec

**Date:** 2026-09-04 · **Status:** approved for implementation (user: "spec, plan and implement"; engines limited to Google, Bing, DuckDuckGo)
**Home:** `~/.dsh/profiles/web/plugins/dsh-web-search-smart/` (own git repo, loaded as a `file:///` plugin row)
**Provider id:** `smart` · **Module name:** `web-search-smart`

---

## 1. Background (all verified against this machine, 2026-09-04)

- The harness `web_search` tool runs through the `ctx.web` seam (`@deepseek-ai/dsh-web` 0.1.2-rc.1). Search providers are pluggable objects: `{id, available(), search({query, maxResults}, signal) → {sources, truncated, answer?}}`, registered by plugin modules exporting `{name, inject: ["web"], Config, apply}`.
- The installed community provider `dsh-web-search-local` has three structural flaws, each observed in production use:
  1. **First-engine-wins sequencing.** `runSearch` (index.js:605) loops engines serially and returns the first non-empty set. A degraded engine poisons the whole answer.
  2. **No degradation detection.** Bing serves this machine's IP randomized bot-feed SERPs, verified in three variants of the same query: zh `setlang` → Google homepage domains; en-US → roof heat-tape pages; default → multilingual `support.google.com` flood. All carry the `"Content was generated with AI"` marker. None of these were filtered; all were returned.
  3. **Silent no-op engines.** The config had `engines: [google, bing, duckduckgo, mojeek, baidu]`, but the plugin's `ENGINES` map (index.js:576) implements no `google`, and `engineList()` (index.js:588) silently drops unknown names. The user's `google` entry was a no-op with no error anywhere.
- Google from this IP: reachable (HTTP 200) but serves a consent/JS shell ("Google Search" title only) to non-browser clients. A browser-grade header set plus consent-cookie retry is required; a `/sorry/` captcha remains possible and must be handled by cooldown, not retry-storms.
- Nothing in the current setup fills the seam's optional `answer` field (my tool renders it as a summary). Only the official DeepSeek provider does, at the cost of a DeepSeek API turn per search — which this deployment deliberately avoids (model is local qwen 3.8 27B via `http://127.0.0.1:18020/v1`).
- The profile's hoisted `~/.dsh/profiles/node_modules/@deepseek-ai/` contains `schemastery`, `dsh-web`, `dsh-llm`, `dsh-llm-retry`, `dsh-timeout`, `dsh-credentials`, `dsh-launch-environment` — a file-based plugin under `profiles/web/plugins/` can import these through normal Node ESM upward resolution. "Zero npm deps" of the community plugin was a choice, not a constraint.

## 2. Goals

| # | Goal |
|---|---|
| G1 | **Parallel fan-out + RRF.** Query Google, Bing, DuckDuckGo concurrently and merge with reciprocal rank fusion. No single engine's set is ever returned unmerged. |
| G2 | **Never serve garbage.** Per-engine block detection (captcha/consent/anomaly) and soft degradation detection (AI-generated SERP markers, single-domain floods, language mismatch, zero topical overlap). A degraded set is discarded; the engine enters a cooldown. Worst case: a small honest result set, or a clear `WebError` — never a bot feed. |
| G3 | **LLM rank + summary via local qwen.** One short `ctx.llm` turn (local model, zero external cost) ranks merged candidates, drops irrelevant ones, and synthesizes a 2–4 sentence `answer` with `[n]` source references. Graceful degradation: model failure/timeout → deterministic RRF order, no answer. Search is never blocked on the model. |
| G4 | **Hot config.** GUI settings page via `installSection`; config changes take effect without a process restart (per-search option snapshot, the pattern of the official DeepSeek provider). |
| G5 | **Keyless, no new external services.** Google/Bing/DDG HTML only. No API keys, no SearXNG, no proxies by default. Dependencies: Node ≥ 18 globals + the profile's hoisted `@deepseek-ai` packages only. |

## 3. Non-goals (v1)

- Mojeek/Baidu/SearXNG/4get/key-based engines. The engine registry is open (name → implementation map); adding one is one module + one config entry.
- No `fetch` provider (keep existing `local-fetch`/`http` pinning for `web_fetch`).
- No proxy support in v1: `proxyUrl` accepts `"off"` (default) only; any explicit URL is a loud `WEB_ENGINE_PROXY` error (this deployment has no usable proxy — the local 8080 listener rejects CONNECT with 400). `"auto"` probing (the community plugin's port-scanning CONNECT probe) is out of scope.
- No persistence across restarts (in-memory TTL cache only; cooldowns reset on restart — acceptable).

## 4. Provider contract (from `dsh-web/lib/index.js` source)

- `search(request, signal)` receives `request = {query, maxResults?}` and must return `{sources: WebSource[], truncated: boolean, answer?: string}` where `WebSource = {url: string, title?: string, snippet?: string, publishedAt?: string}` (ISO-8601). The seam truncates `sources` to `maxResults` itself and sets `truncated`.
- `available()` → `true` when the provider is configured and at least one engine is not permanently disabled; `false` only for fundamentally broken config (the seam then raises `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`). All-runtime failures (all engines cooling down) are thrown from `search()` as descriptive `WebError`s instead.
- Errors: `WebError` with machine-routable codes — `WEB_ABORTED` (signal aborted; keep `signal.reason` as cause) and `WEB_PROVIDER_ERROR` otherwise. Failure messages follow the official provider's recovery-hint pattern (name the endpoint, tell the user where to configure it: Settings → Plugins → Plugin configuration).
- Module shape (mirrors `dsh-web-search-deepseek/lib/index.js`):
  ```js
  export const name = "web-search-smart";
  export const inject = ["web"];
  export const Config = z.object({ /* §8 */ });
  export function apply(ctx, config) { /* installSection + registerSearchProvider */ }
  ```
  `apply` installs a settings section (namespace `web-search-smart`) with a `setSource` thunk so config changes swap the option snapshot without re-registration; registers `new SmartSearchProvider(() => resolveOptions(ctx, current()))` — identical hot-reload mechanics to the official provider.

## 5. Architecture

```
search({query, maxResults}, signal)
 ├─ 0  cache: key = `${query}::${engines.join(",")}::${locale}`, TTL 300 s (in-memory, LRU 200)
 ├─ 1  fan-out: Promise.allSettled over engines, each with deadline(parentSignal, 10 s, "WEB_ENGINE_TIMEOUT")
 │      google / bing / duckduckgo → {ok: candidates[]} | {blocked} | {degraded, reason} | {error}
 ├─ 2  per-engine validation (inside each engine module; see §6)
 │      hard block  → discard + cooldown 60 min
 │      degraded    → discard + cooldown 10 min (reason recorded)
 ├─ 3  merge (merge.js): normalize URLs (unwrap google `/url?q=`, strip tracking params)
 │      → dedupe → RRF score k=60 (Σ 1/(60+rank) per engine) → sort desc → top 12
 │      → language gate: if ≥60% of top-12 snippets are a different script family than
 │        the query, keep only matching (if that empties the set, keep original, flagged)
 ├─ 4  LLM step (llm.js; if llmRanking and candidates > 0 and llm available):
 │      one ctx.llm.stream turn (provider/model from config, deadline 15 s, maxTokens 1024)
 │      strict-JSON response → {ranked: [i…], answer: "…"}; defensive parse (§7)
 │      success → reorder + drop model-flagged + set `answer`
 │      failure/timeout/non-JSON → deterministic RRF order, no `answer`
 ├─ 5  cap to maxResults (defensive; seam also caps), set truncated
 └─ 6  cache set; session event "web/smart-search" {query, engines: {name: ok|degraded|blocked|error, n},
        llm: used|skipped|failed, ms} via ctx.get("agents")?.currentInitiator()?.session
```

## 6. Engines

Common to all: `GET`, browser-grade header set (`user-agent` = modern desktop Chrome, `accept: text/html,…`, `accept-language: en-US,en;q=0.9`, `sec-ch-ua`, `sec-fetch-*`, `upgrade-insecure-headers`), direct egress (`proxyUrl: "off"`; any other value errors with `WEB_ENGINE_PROXY` — no proxy support in v1), `maxBytes` 1 MB, charset decode from `Content-Type` else `<meta charset>` else UTF-8, abortable.

### 6.1 Google (`engines/google.js`)

- `https://www.google.com/search?q={q}&hl={locale}&gl={locale}&num=20`
- **Consent wall:** response contains a `consent` frame/redirect (or body is the bare "Google Search" shell) → retry once with `Cookie: SOCS=CAI; CONSENT=YES+cb`. Still a wall → hard block.
- **Hard block:** URL `/sorry/`, or body markers `unusual traffic`, `captcha`, `enable JavaScript` wall, bare title-only body → discard + 60-min cooldown.
- **Parse:** organic results as `<h3>`-anchored blocks; unwrap `href="/url?q={enc}&…"` to the real URL (skip `/url?q=` that resolve to `google.*`/`accounts.*`); snippet from the result block's description span. Multiple regex fallbacks (markup is volatile).
- **Degraded:** fewer than 3 parseable results from a 200 response (bot-feed HTML parses to almost nothing) → discard + 10-min cooldown.

### 6.2 Bing (`engines/bing.js`) — the reliability anchor on this IP today

- `https://www.bing.com/search?q={q}&count=20&setlang={locale}&cc={locale}`
- **Hard block:** `captcha`/`challenge` markers (community plugin's existing check).
- **Degraded** (the core value-add; any one fires):
  - body contains `Content was generated with AI`;
  - ≥70% of the top-10 share one registrable domain (the `support.google.com`-flood pattern);
  - zero top-10 titles share a content token with the query (stopword-filtered overlap);
  - dominant snippet script family ≠ query script family.
- **Parse:** `<li class="b_algo…">` blocks, `<h2><a href>` + description (community plugin's proven selectors, kept).

### 6.3 DuckDuckGo (`engines/duckduckgo.js`)

- `https://html.duckduckgo.com/html/?q={q}&kl=us-{locale}` (the HTML endpoint, not lit; it is the best-behaved engine on this IP — verified)
- **Hard block:** HTTP 403, `anomaly-modal`, `challenge` markers (DDG rate-limits repeat queryers) → discard + 60-min cooldown.
- **Parse:** `result__a` links (decode `//duckduckgo.com/l/?uddg={enc}` → real URL), `result__snippet`, `result__title`.

## 7. LLM step (`llm.js`)

- Route: config `llmProvider: "qwen-local"`, `llmModel: "qwen3.8-27b"` (defaults = this deployment's local setup; always an explicit pair — never the "logged request route" path, which the title plugin requires its service request to carry and the web seam does not provide).
- Call (pattern of `dsh-session-title-llm`): `createUserMessage({content:[{type:"text",text}], source:{kind:"plugin",plugin:"dsh-web-search-smart"}})` → `ctx.llm.stream({provider, model, system, messages, maxTokens: 1024, purpose: "web-search", sessionId?, signal: deadline(signal, llmTimeoutMs, "WEB_LLM_TIMEOUT").signal})` → `BlockAssembler`.
- **System prompt:** filter-and-summarize the numbered candidate list (url, title, snippet); respond with exactly one JSON object `{"ranked":[…indices in relevance order…],"answer":"2–4 sentences citing sources as [n]"}`; drop indices that are irrelevant or show bot-feed traits; if none is relevant, `ranked` may be empty and `answer` must say so.
- **Defensive parse:** extract first `{`…last `}`; validate `ranked` = unique integers in range; `answer` = non-empty string ≤ 500 chars (truncated at 500). Any violation → fallback. Accept finish `stop` only (`max-tokens`/`tool-calls`/`error` → fallback).
- **Fallback (never blocks search):** deterministic RRF order, no `answer`, event `llm: "failed"`.

## 8. Config (GUI page: Settings → Plugins → *web-search-smart*)

| Field | Type | Default | Notes |
|---|---|---|---|
| `engines` | string[] | `["google","bing","duckduckgo"]` | order = RRF tie-break preference |
| `locale` | string | `"en"` | feeds hl/gl/kl/setlang/cc |
| `userAgent` | string | modern desktop Chrome | |
| `proxyUrl` | string | `"off"` | v1: `"off"` only; other values error with `WEB_ENGINE_PROXY` |
| `searchTimeoutMs` | number | 10000 | per-engine deadline |
| `llmRanking` | boolean | `true` | |
| `llmProvider` | string | `"qwen-local"` | `ctx.llm` route |
| `llmModel` | string | `"qwen3.8-27b"` | `ctx.llm` route |
| `llmTimeoutMs` | number | 15000 | |
| `llmMaxCandidates` | number | 12 | candidates sent to the model |
| `maxSources` | number | 12 | pre-seam cap |
| `cacheTtlMs` / `cacheMax` | number | 300000 / 200 | parity with community plugin |

Schema via `@deepseek-ai/schemastery` `z.object` (`.default()` on every field → GUI form), installed with `installSection(ctx, "web-search-smart", Config, config, {setSource, onChange})`.

## 9. Wiring (user profile `cordis.patch.yml`)

```yaml
- id: web
  config:
    searchProvider: smart        # was: local-multi
    fetchProvider: local-fetch   # unchanged

- id: web-search-deepseek
  disabled: true                 # unchanged

- insert:
  - id: web-search-local         # kept as fallback; no longer pinned
    name: 'file:///home/sofoli/.dsh/profiles/web/plugins/dsh-web-search-local/index.js'
    config:
      engines: [google, bing, duckduckgo, mojeek, baidu]
  - id: web-search-smart         # new
    name: 'file:///home/sofoli/.dsh/profiles/web/plugins/dsh-web-search-smart/index.js'
```

One dsh process restart loads the new module (file-based plugins import at profile load; `patchReload: live` covers config, not module code). Thereafter, config edits hot-reload.

## 10. Test plan

1. **Self-test (pre-restart, from the repo):** `node scripts/selftest.mjs` — exercises each engine module + merge + (optional) LLM directly against the same egress the plugin will use; prints per-engine verdict (ok/degraded/blocked/error, counts, top-3). Run against: the two baseline queries ("DiceBear Avataaars Flutter avatar generation", "RTX 3090 VRAM gigabytes") + one Flutter-ecosystem query + one fresh-news query.
2. **Integration (after user restarts dsh):** `web_search` with the two baseline queries → expect no multilingual floods, no domain-family spam, English results, a summary answer, and a `web/smart-search` session event showing per-engine status.
3. **Failure modes:** (a) qwen container down → search still returns (deterministic, no answer); (b) all three engines blocked/degraded → clear `WebError` naming each engine's reason and cooldown.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Google hard-blocks this IP (`/sorry/`), unlike Bing | Auto-cooldown; provider degrades to Bing+DDG, which RRF + the degradation gate + LLM already make better than today's first-wins |
| Google markup churn breaks parsing | Multiple regex fallbacks; "too few parsed" is treated as degraded, never as success |
| DDG anomaly throttling under repeated self-tests | 60-min cooldown, single request per query, no retries on 403 |
| 27B model occasionally emits non-JSON | Defensive parse; fallback costs nothing functional |
| Cooldowns in-memory | Reset on restart — acceptable (v1) |

## 12. Repo layout

```
index.js              # name/inject/Config/apply + SmartSearchProvider (fan-out, merge, llm, cache, events)
http.js               # browserRequest: headers, timeout/abort, proxy off|explicit, charset, maxBytes
cache.js              # TTL + LRU map
engines/google.js     # §6.1
engines/bing.js       # §6.2
engines/duckduckgo.js # §6.3
merge.js              # URL normalize/dedupe, RRF, language gate
llm.js                # §7
scripts/selftest.mjs  # §10.1
docs/2026-09-04-dsh-web-search-smart-design.md
package.json  README.md  LICENSE (MIT)  .gitignore
```
