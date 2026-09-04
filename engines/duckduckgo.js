// DuckDuckGo HTML endpoint — the best-behaved keyless engine on this IP
// (verified: topically adjacent results where Bing serves bot-feeds).
// Verdicts: ok | blocked (403/anomaly) | degraded. See docs spec §6.3.

import { getHtml, cleanHtml } from "../http.js";

/** Decode DDG's /l/?uddg= redirect wrapper; pass through direct URLs. */
function unwrap(href) {
  if (!href) return null;
  if (href.startsWith("//")) href = "https:" + href;
  if (!href.startsWith("http://") && !href.startsWith("https://")) return null;
  try {
    const u = new URL(href);
    if (u.hostname.endsWith("duckduckgo.com") && u.pathname.startsWith("/l/")) {
      const uddg = u.searchParams.get("uddg");
      return uddg && /^https?:\/\//i.test(uddg) ? uddg : null;
    }
    return href;
  } catch {
    return null;
  }
}

function parse(body) {
  const titles = [...body.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].map(
    (m) => ({ url: unwrap(m[1]), title: cleanHtml(m[2], 200) })
  );
  const snippets = [...body.matchAll(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)].map(
    (m) => cleanHtml(m[1], 320)
  );
  // an ad slot can add one extra snippet before the first organic result
  if (snippets.length === titles.length + 1) snippets.shift();
  const out = [];
  for (let i = 0; i < titles.length; i++) {
    const t = titles[i];
    if (!t.url || !t.title) continue;
    const snippet = snippets[i];
    out.push({ url: t.url, title: t.title, ...(snippet && snippet.length >= 40 ? { snippet } : {}) });
    if (out.length >= 20) break;
  }
  return out;
}

export async function search(query, cfg, signal) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=us-${cfg.locale}`;
  const r = await getHtml(url, cfg, signal);
  if (r.status === 403) return { status: "blocked", reason: "HTTP 403 (rate limit / anomaly)" };
  if (r.status !== 200) return { status: "blocked", reason: `HTTP ${r.status}` };
  if (/anomaly-modal|challenge|captcha/i.test(r.body.slice(0, 20000)))
    return { status: "blocked", reason: "anomaly/challenge page" };
  if (/no results|did not match any documents/i.test(r.body)) return { status: "ok", results: [] };
  const results = parse(r.body);
  if (r.body.includes("result__a") && results.length < 3)
    return { status: "degraded", reason: `markup change: ${results.length} results parsed` };
  if (results.length < 3) return { status: "degraded", reason: `only ${results.length} results parsed` };
  return { status: "ok", results };
}
