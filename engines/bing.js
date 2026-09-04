// Bing organic results with active bot-feed degradation detection — the core
// value-add over the community plugin (which served Bing's degraded feeds
// verbatim). Verdicts: ok | blocked | degraded. See docs spec §6.2.

import { getHtml, cleanHtml } from "../http.js";
import { scriptFamily } from "../merge.js";

const STOPWORDS = new Set([
  "the", "a", "an", "in", "of", "for", "to", "and", "or", "with", "that", "this",
  "is", "are", "was", "be", "how", "what", "when", "where", "who", "why", "can",
  "do", "does", "your", "my", "its", "it", "on", "at", "by", "from", "as",
  "into", "about", "use", "using", "via", "per",
]);

function contentTokens(q) {
  return [
    ...new Set(
      String(q)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    ),
  ];
}

/** Naive registrable domain: last two labels (co.uk edge cases accepted). */
function registrable(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    const parts = h.split(".");
    return parts.length >= 2 ? parts.slice(-2).join(".") : h;
  } catch {
    return "";
  }
}

/**
 * Bot-feed detection. Any single hit ⇒ the whole set is discarded:
 * (a) Bing's "Content was generated with AI" marker (verified on this IP),
 * (b) one domain family holding ≥7 of the top 10 (the support.google.com
 *     flood pattern),
 * (c) zero topical token overlap between the query and all top-10 titles,
 * (d) dominant result script family ≠ query script family.
 */
export function isDegraded(body, results, query) {
  const head = body.slice(0, 30000);
  if (/content was generated with ai/i.test(head)) return "AI-generated SERP marker";
  const top = results.slice(0, 10);
  if (top.length >= 5) {
    const counts = new Map();
    for (const r of top) {
      const d = registrable(r.url);
      if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    const [dom, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
    if (n >= 7) return `domain flood: ${dom} holds ${n}/10`;
  }
  const toks = contentTokens(query);
  if (toks.length > 0) {
    const anyOverlap = top.some((r) => {
      const t = (r.title ?? "").toLowerCase();
      return toks.some((tok) => t.includes(tok));
    });
    if (!anyOverlap) return "no topical token overlap between query and top-10 titles";
  }
  const famQ = scriptFamily(query);
  if (famQ !== "other" && top.length >= 5) {
    const foreign = top.filter(
      (r) => scriptFamily(`${r.snippet ?? ""} ${r.title ?? ""}`) !== famQ
    ).length;
    if (foreign / top.length >= 0.6) return "dominant result language mismatches query";
  }
  return null;
}

function parse(body) {
  const out = [];
  for (const block of body.matchAll(/<li class="b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi)) {
    const b = block[1];
    const tm = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(b);
    if (!tm) continue;
    const url = tm[1];
    if (!url.startsWith("http://") && !url.startsWith("https://")) continue;
    const title = cleanHtml(tm[2], 200);
    if (!title) continue;
    // first <p> that is a real description, not the "host › path" source line
    let snippet;
    for (const pm of b.matchAll(/<p[^>]*>([\s\S]{20,500}?)<\/p>/gi)) {
      const t = cleanHtml(pm[1], 320);
      if (t.length >= 40 && !/^[a-z0-9.-]+\.[a-z.]+( ›| >)/i.test(t)) {
        snippet = t;
        break;
      }
    }
    out.push({ url, title, ...(snippet ? { snippet } : {}) });
    if (out.length >= 20) break;
  }
  return out;
}

export async function search(query, cfg, signal) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=20&setlang=${cfg.locale}&cc=${cfg.locale}`;
  const r = await getHtml(url, cfg, signal);
  if (r.status !== 200) return { status: "blocked", reason: `HTTP ${r.status}` };
  if (/captcha|challenge/i.test(r.body.slice(0, 20000))) return { status: "blocked", reason: "captcha/challenge" };
  const results = parse(r.body);
  const why = isDegraded(r.body, results, query);
  if (why) return { status: "degraded", reason: why };
  if (results.length < 3) return { status: "degraded", reason: `only ${results.length} organic results parsed` };
  return { status: "ok", results };
}
