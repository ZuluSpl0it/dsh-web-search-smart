// Google organic results via HTML search page. Keyless; consent-wall aware.
// Verdicts: ok | blocked (captcha/consent → long cooldown) | degraded
// (bot-feed or markup change → short cooldown). See docs spec §6.1.

import { getHtml, cleanHtml } from "../http.js";

/** EU consent bypass: standard SOCS cookie (skip the consent interstitial). */
const CONSENT_COOKIE = "SOCS=CAI; CONSENT=YES+cb.20240101-01-p+EN+FX+000";

/** Unwrap Google's /url?q= redirect wrapper; keep plain http(s) URLs. */
function unwrap(href) {
  if (!href) return null;
  if (href.startsWith("http://") || href.startsWith("https://")) return href;
  if (href.startsWith("/url?")) {
    try {
      const u = new URL(href, "https://www.google.com");
      const q = u.searchParams.get("q");
      if (q && /^https?:\/\//i.test(q)) return q;
    } catch {
      return null;
    }
  }
  return null;
}

/** Consent interstitial, or the bare JS-only shell served to non-browser clients. */
function isConsentWall(url, body) {
  if (/consent\.google\./i.test(url)) return true;
  if (/before you continue to google|consent\.google\.com/i.test(body.slice(0, 20000))) return true;
  // bare shell: tiny body, Google branding, no organic <h3> results
  const h3 = (body.match(/<h3/g) ?? []).length;
  if (h3 < 3 && /google/i.test(body) && body.length < 60000) return true;
  return false;
}

/** Hard bot-block pages. Returns a human reason string, or null when clean. */
function isHardBlock(url, body) {
  if (url.includes("/sorry/")) return "google /sorry/ captcha";
  const head = body.slice(0, 20000);
  if (/unusual traffic/i.test(head)) return "unusual traffic page";
  if (/\brecaptcha\b/i.test(head)) return "recaptcha challenge";
  if (/enable javascript/i.test(head) && /captcha|sorry|denied/i.test(head)) return "javascript/captcha wall";
  return null;
}

/**
 * Primary parse: <a href="…"><h3>title</h3></a> pairs, with the first plausible
 * description span that follows. Google markup is volatile — callers fall back
 * to parseFallback when fewer than 3 results come out.
 */
function parse(body) {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]+href="([^"]+)"[^>]*>\s*<h3[^>]*>([\s\S]*?)<\/h3>/g;
  let m;
  while ((m = re.exec(body))) {
    const url = unwrap(m[1]);
    if (!url || seen.has(url)) continue;
    const title = cleanHtml(m[2], 200);
    if (!title) continue;
    seen.add(url);
    const after = body.slice(re.lastIndex, re.lastIndex + 3000);
    const sm = /<span[^>]*>([\s\S]{60,600}?)<\/span>/i.exec(after);
    let snippet;
    if (sm) {
      const t = cleanHtml(sm[1], 320);
      if (t.length >= 40) snippet = t;
    }
    out.push({ url, title, ...(snippet ? { snippet } : {}) });
    if (out.length >= 20) break;
  }
  return out;
}

/** Fallback: any <h3> with an <a href="https?://…"> within the preceding 300 chars. */
function parseFallback(body) {
  const out = [];
  const seen = new Set();
  for (const m of body.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)) {
    const before = body.slice(Math.max(0, m.index - 300), m.index);
    const hrefs = [...before.matchAll(/href="([^"]+)"/g)];
    const url = unwrap(hrefs.at(-1)?.[1]);
    if (!url || seen.has(url)) continue;
    const title = cleanHtml(m[1], 200);
    if (!title) continue;
    seen.add(url);
    out.push({ url, title });
    if (out.length >= 20) break;
  }
  return out;
}

export async function search(query, cfg, signal) {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=${cfg.locale}&gl=${cfg.locale}&num=20`;
  let r = await getHtml(url, cfg, signal);
  if (r.status !== 200) return { status: "blocked", reason: `HTTP ${r.status}` };
  if (isConsentWall(r.url, r.body)) {
    r = await getHtml(url, cfg, signal, { extraHeaders: { cookie: CONSENT_COOKIE } });
    if (r.status !== 200) return { status: "blocked", reason: `consent retry HTTP ${r.status}` };
    if (isConsentWall(r.url, r.body)) return { status: "blocked", reason: "consent wall (SOCS retry failed)" };
  }
  const block = isHardBlock(r.url, r.body);
  if (block) return { status: "blocked", reason: block };
  let results = parse(r.body);
  if (results.length < 3) results = parseFallback(r.body);
  if (results.length < 3)
    return { status: "degraded", reason: `only ${results.length} organic results parsed (bot-feed or markup change)` };
  return { status: "ok", results };
}
