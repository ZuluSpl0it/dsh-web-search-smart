// Cross-engine merge: URL normalization, dedupe, reciprocal rank fusion,
// language gate. See docs spec §5.3.

const TRACKING = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "gclid", "fbclid", "s_kwcid", "sp_mc", "mc_cid", "mc_eid",
  "pk_campaign", "pk_kwd",
]);

/**
 * Canonicalize a URL: unwrap Google /url?q= wrappers, strip tracking params
 * and hashes, lowercase the host. Returns null for unparseable URLs.
 */
export function normalizeUrl(u) {
  try {
    const url = new URL(u);
    if (url.pathname.startsWith("/url?q=")) {
      const q = new URLSearchParams(url.search).get("q");
      if (q && /^https?:\/\//i.test(q)) return normalizeUrl(q);
      return null;
    }
    for (const key of [...url.searchParams.keys()])
      if (TRACKING.has(key.toLowerCase())) url.searchParams.delete(key);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    return url.toString();
  } catch {
    return null;
  }
}

/** Script family of a string: cjk | latin | other (undecidable). */
export function scriptFamily(text) {
  const t = String(text ?? "");
  const cjk = (t.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const latin = (t.match(/[a-z]/gi) ?? []).length;
  if (cjk > latin) return "cjk";
  if (latin > cjk) return "latin";
  return "other";
}

/**
 * Merge per-engine result sets with reciprocal rank fusion (k=60).
 * @param sets - Map<engineName, results[]> in preference order.
 * @param cfg - config (llmMaxCandidates bounds the returned list).
 * @param query - original query (for the language gate).
 * @returns merged sources (url/title/snippet/publishedAt/score/engines), best first.
 */
export function mergeResults(sets, cfg, query) {
  const K = 60;
  const order = [...sets.keys()];
  const byUrl = new Map();
  for (const [engine, results] of sets) {
    results.forEach((r, rank) => {
      const url = normalizeUrl(r.url);
      if (!url) return;
      let e = byUrl.get(url);
      if (!e) {
        e = { url, engines: [] };
        byUrl.set(url, e);
      }
      e.engines.push({ engine, rank });
      if (!e.title && r.title) e.title = r.title;
      if (!e.snippet && r.snippet) e.snippet = r.snippet;
      if (!e.publishedAt && r.publishedAt) e.publishedAt = r.publishedAt;
    });
  }
  const firstRank = (e) =>
    Math.min(...e.engines.map((x) => order.indexOf(x.engine) * 10000 + x.rank));
  const scored = [...byUrl.values()].map((e) => ({
    ...e,
    score: e.engines.reduce((s, x) => s + 1 / (K + x.rank + 1), 0),
  }));
  scored.sort((a, b) => b.score - a.score || firstRank(a) - firstRank(b));
  const top = scored.slice(0, cfg.llmMaxCandidates ?? 12);
  return languageGate(query, top);
}

/**
 * Language gate: if ≥60% of the top candidates are in a different script
 * family than the query, keep only the matching ones (if that empties the
 * set, keep the original — better small-and-wrong-family than nothing).
 */
export function languageGate(query, top) {
  if (top.length < 5) return top;
  const qfam = scriptFamily(query);
  if (qfam === "other") return top;
  const famOf = (r) => scriptFamily(`${r.snippet ?? ""} ${r.title ?? ""}`);
  const foreign = top.filter((r) => famOf(r) !== "other" && famOf(r) !== qfam).length;
  if (foreign / top.length < 0.6) return top;
  const kept = top.filter((r) => famOf(r) === qfam || famOf(r) === "other");
  return kept.length > 0 ? kept : top;
}
