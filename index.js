// dsh-web-search-smart — keyless multi-engine web search provider for the
// dsh-web seam (provider id "smart"). Parallel Google/Bing/DuckDuckGo fan-out,
// RRF merge with bot-feed degradation detection, optional local-LLM ranking
// and summary. Module shape mirrors @deepseek-ai/dsh-web-search-deepseek.
// See docs/2026-09-04-dsh-web-search-smart-design.md.

import z from "@deepseek-ai/schemastery";
import { WebError } from "@deepseek-ai/dsh-web";
import { TTLCache } from "./cache.js";
import { mergeResults } from "./merge.js";
import { rankAndAnswer } from "./llm.js";
import { DEFAULT_USER_AGENT, linkedDeadline } from "./http.js";
import { search as googleSearch } from "./engines/google.js";
import { search as bingSearch } from "./engines/bing.js";
import { search as duckDuckGoSearch } from "./engines/duckduckgo.js";

export const name = "web-search-smart";
export const inject = ["web"];

/** Open registry: adding an engine = implement search(query, cfg, signal) → verdict, add here. */
export const ENGINES = {
  google: googleSearch,
  bing: bingSearch,
  duckduckgo: duckDuckGoSearch,
};

const BLOCK_COOLDOWN_MS = 3_600_000; // hard block: 60 min
const DEGRADED_COOLDOWN_MS = 600_000; // bot-feed discard: 10 min

/** GUI settings section (Settings > Plugins > Plugin configuration > web-search-smart). */
export const Config = z.object({
  engines: z.array(z.string()).default(["google", "bing", "duckduckgo"]),
  locale: z.string().default("en"),
  userAgent: z.string().default(DEFAULT_USER_AGENT),
  proxyUrl: z.string().default("off"),
  searchTimeoutMs: z.number().step(1).min(1).default(10000),
  llmRanking: z.boolean().default(true),
  llmProvider: z.string().default("qwen-local"),
  llmModel: z.string().default("qwen3.8-27b"),
  llmTimeoutMs: z.number().step(1).min(1).default(15000),
  llmMaxCandidates: z.number().step(1).min(1).default(12),
  maxSources: z.number().step(1).min(1).default(12),
  cacheTtlMs: z.number().step(1).min(1).default(300000),
  cacheMax: z.number().step(1).min(1).default(200),
});

/** Keep only engines the registry actually implements (silent-no-op guard). */
function resolveOptions(ctx, config) {
  const o = { ...config };
  o.engines = (o.engines ?? []).filter((n) => typeof n === "string" && ENGINES[n]);
  return o;
}

function aborted(signal) {
  return new WebError("web search aborted", "WEB_ABORTED", {
    cause: signal?.aborted === true ? signal.reason : undefined,
  });
}

export class SmartSearchProvider {
  id = "smart";
  #ctx;
  #resolveOptions;
  #cooldowns = new Map(); // engine name → cooldown-until epoch ms (in-memory, v1)
  #cache = new TTLCache({ ttlMs: 300000, max: 200 });
  #cacheId = "";

  constructor(ctx, resolveOptions) {
    this.#ctx = ctx;
    this.#resolveOptions = resolveOptions;
  }

  /** Usable = at least one configured engine exists (runtime failures throw from search()). */
  available() {
    try {
      return this.#resolveOptions().engines.length > 0;
    } catch {
      return false;
    }
  }

  async search(request, signal) {
    if (signal?.aborted === true) throw aborted(signal);
    const o = this.#resolveOptions();
    const query = String(request?.query ?? "").trim();
    if (!query) throw new WebError("query must be a non-empty string", "WEB_PROVIDER_ERROR");
    if (o.engines.length === 0)
      throw new WebError(
        'no search engines configured (set "engines" in Settings > Plugins > Plugin configuration > web-search-smart)',
        "WEB_PROVIDER_ERROR"
      );

    // cache identity tracks the settings that define it (hot-reload safe)
    const cacheId = `${o.cacheTtlMs}:${o.cacheMax}`;
    if (this.#cacheId !== cacheId) {
      this.#cache = new TTLCache({ ttlMs: o.cacheTtlMs, max: o.cacheMax });
      this.#cacheId = cacheId;
    }
    const cacheKey = `${query}::${o.engines.join(",")}::${o.locale}`;
    const cached = this.#cache.get(cacheKey);
    if (cached) return { ...cached };

    const t0 = Date.now();
    const now = Date.now();
    const active = o.engines.filter((n) => (this.#cooldowns.get(n) ?? 0) <= now);
    if (active.length === 0) {
      const detail = o.engines
        .map((n) => `${n}: cooling down until ${new Date(this.#cooldowns.get(n)).toUTCString()}`)
        .join("; ");
      throw new WebError(`all search engines are cooling down (${detail})`, "WEB_PROVIDER_ERROR");
    }

    // parallel fan-out; each engine is bounded by its own deadline and cannot throw
    const settled = await Promise.all(
      active.map(async (n) => {
        const d = linkedDeadline(signal, o.searchTimeoutMs, "WEB_ENGINE_TIMEOUT");
        let r;
        try {
          r = await ENGINES[n](query, o, d.signal);
        } catch (e) {
          if (signal?.aborted === true) throw aborted(signal);
          const code = d.signal.aborted ? d.signal.reason?.code : undefined;
          r = {
            status: "error",
            reason: code === "WEB_ENGINE_TIMEOUT" ? `timeout after ${o.searchTimeoutMs}ms` : String(e?.message ?? e),
          };
        } finally {
          d.dispose();
        }
        return { n, r };
      })
    );

    // per-engine verdicts: ok sets merge; blocked/degraded discard + cooldown
    const candidateSets = new Map();
    const statuses = {};
    const degradedNotes = [];
    for (const { n, r } of settled) {
      if (r.status === "ok") {
        statuses[n] = `ok(${r.results.length})`;
        if (r.results.length > 0) candidateSets.set(n, r.results);
      } else if (r.status === "blocked") {
        this.#cooldowns.set(n, Date.now() + BLOCK_COOLDOWN_MS);
        statuses[n] = `blocked: ${r.reason}`;
      } else if (r.status === "degraded") {
        this.#cooldowns.set(n, Date.now() + DEGRADED_COOLDOWN_MS);
        degradedNotes.push(`${n} (${r.reason})`);
        statuses[n] = `degraded: ${r.reason}`;
      } else {
        statuses[n] = `error: ${r.reason}`;
      }
    }

    if (candidateSets.size === 0) {
      const parts = active.map((n) => `${n}=${statuses[n]}`);
      const extra = degradedNotes.length ? ` | degraded sets discarded: ${degradedNotes.join("; ")}` : "";
      throw new WebError(
        `all search engines failed (${parts.join("; ")})${extra}\n\nSearch configuration: Settings > Plugins > Plugin configuration > web-search-smart (engines, locale, timeouts).`,
        "WEB_PROVIDER_ERROR"
      );
    }

    const merged = mergeResults(candidateSets, o, query);
    let sources = merged.slice(0, o.maxSources);
    let answer;
    let llmStatus = "skipped";
    if (o.llmRanking && sources.length > 0) {
      const res = await rankAndAnswer(this.#ctx, { ...o, query }, sources, signal);
      if (res) {
        llmStatus = "used";
        sources = res.ranked.map((i) => sources[i]).filter(Boolean);
        if (res.answer) answer = res.answer;
      } else {
        llmStatus = "failed";
      }
    }
    if (signal?.aborted === true) throw aborted(signal);

    const result = {
      sources: sources.map((s) => ({
        url: s.url,
        ...(s.title ? { title: s.title } : {}),
        ...(s.snippet ? { snippet: s.snippet } : {}),
        ...(s.publishedAt ? { publishedAt: s.publishedAt } : {}),
      })),
      truncated: merged.length > o.maxSources,
      ...(answer ? { answer } : {}),
    };
    this.#cache.set(cacheKey, result);
    try {
      this.#ctx
        .get("agents")
        ?.currentInitiator?.()
        ?.session?.append("web/smart-search", {
          query,
          engines: statuses,
          llm: llmStatus,
          ms: Date.now() - t0,
        });
    } catch {
      /* no session context (e.g. self-test) — best effort only */
    }
    return { ...result };
  }
}

export function apply(ctx, config) {
  let current = () => config;
  ctx.inject(["settings"], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, "web-search-smart", Config, config, {
      setSource: (source) => {
        current = source; // hot-reload: later reads see live section values
      },
      onChange: () => {},
    });
  });
  ctx.web.registerSearchProvider(new SmartSearchProvider(ctx, () => resolveOptions(ctx, current())));
}
