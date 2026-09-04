// Shared HTTP plumbing for all engines: browser-grade headers, timeout/abort,
// charset decoding, size cap. Plain global fetch — no dsh imports, so
// scripts/selftest.mjs can exercise it outside the harness.
//
// proxyUrl: v1 supports "off" only (direct egress). Any other value fails
// loudly at request time; an explicit CONNECT proxy is a v2 item.

/** Modern desktop Chrome UA (the header set that gets real SERPs, not shells). */
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export function acceptLanguage(locale) {
  const l = String(locale || "en");
  return l === "en" ? "en-US,en;q=0.9" : `${l},en;q=0.9`;
}

export function browserHeaders(cfg, extra = {}) {
  return {
    "user-agent": cfg.userAgent,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": acceptLanguage(cfg.locale),
    "sec-ch-ua": '"Chromium";v="131", "Google Chrome";v="131", "Not_A Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "upgrade-insecure-headers": "1",
    ...extra,
  };
}

/**
 * Combine an optional parent AbortSignal with a timeout into one disposable
 * deadline. Aborting either aborts the combined signal; the timeout's reason
 * carries `code` for callers to distinguish timeout from parent abort.
 */
export function linkedDeadline(signal, ms, code) {
  const ac = new AbortController();
  let timer;
  const onAbort = () => ac.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) ac.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  timer = setTimeout(() => ac.abort(Object.assign(new Error(code), { code })), ms);
  return {
    signal: ac.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/** Decode a body buffer with the charset from Content-Type or the meta tag. */
export function decodeHtml(buf, contentType, head) {
  let m = /charset=["']?([\w-]+)/i.exec(contentType ?? "");
  if (!m) m = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head ?? "");
  const cs = (m?.[1] ?? "utf-8").toLowerCase();
  try {
    return new TextDecoder(cs).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

/** Strip tags and decode common HTML entities; collapse whitespace. */
export function cleanHtml(s, max) {
  let t = String(s ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  t = t
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(Number(n));
      } catch {
        return "";
      }
    })
    .replace(/&amp;/g, "&"); // last, so &amp;lt; is not double-decoded
  t = t.replace(/\s+/g, " ").trim();
  return max ? t.slice(0, max) : t;
}

/** Read a response body, failing if it exceeds maxBytes. */
async function readBounded(res, maxBytes) {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error(`response exceeds ${maxBytes} bytes`), { code: "WEB_ENGINE_TOO_LARGE" });
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Browser-grade GET against one search endpoint.
 * @returns {{status:number, url:string, body:string}} final URL after redirects.
 * @throws Error with `.code` — WEB_ENGINE_TIMEOUT, WEB_ENGINE_ABORTED, or WEB_ENGINE_PROXY.
 */
export async function getHtml(url, cfg, signal, { extraHeaders = {} } = {}) {
  if (cfg.proxyUrl && cfg.proxyUrl !== "off")
    throw Object.assign(
      new Error(`proxyUrl "${cfg.proxyUrl}" is not supported in v1 (set "off" for direct egress)`),
      { code: "WEB_ENGINE_PROXY" }
    );
  const d = linkedDeadline(signal, cfg.searchTimeoutMs, "WEB_ENGINE_TIMEOUT");
  try {
    const res = await fetch(url, {
      headers: browserHeaders(cfg, extraHeaders),
      redirect: "follow",
      signal: d.signal,
    });
    const buf = await readBounded(res, 1_000_000);
    const head = new TextDecoder("utf-8", { fatal: false }).decode(buf.slice(0, 2000));
    const body = decodeHtml(buf, res.headers.get("content-type"), head);
    return {
      status: res.status,
      url: res.url || url,
      body,
    };
  } catch (e) {
    if (d.signal.aborted) {
      const code = d.signal.reason?.code;
      throw Object.assign(
        new Error(
          code === "WEB_ENGINE_TIMEOUT"
            ? `timeout after ${cfg.searchTimeoutMs}ms`
            : String(d.signal.reason?.message ?? "aborted")
        ),
        { code: code ?? "WEB_ENGINE_ABORTED" }
      );
    }
    throw e;
  } finally {
    d.dispose();
  }
}
