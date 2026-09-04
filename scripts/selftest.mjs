// Out-of-harness engine + merge self-test. Runs the same code paths the
// plugin uses, straight from this machine's egress (identical to what the
// plugin will see). Usage:
//   node scripts/selftest.mjs ["query" ...]
// (no args → the baseline probe queries)

import { search as googleSearch } from "../engines/google.js";
import { search as bingSearch } from "../engines/bing.js";
import { search as duckDuckGoSearch } from "../engines/duckduckgo.js";
import { mergeResults } from "../merge.js";
import { DEFAULT_USER_AGENT } from "../http.js";

const cfg = {
  locale: "en",
  userAgent: DEFAULT_USER_AGENT,
  proxyUrl: "off",
  searchTimeoutMs: 12000,
  llmMaxCandidates: 12,
};

const queries = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "DiceBear Avataaars Flutter avatar generation",
      "RTX 3090 VRAM gigabytes",
    ];

const ENGINES = { google: googleSearch, bing: bingSearch, duckduckgo: duckDuckGoSearch };

let failures = 0;
for (const q of queries) {
  console.log(`\n=== ${q}`);
  const t0 = Date.now();
  const settled = await Promise.all(
    Object.entries(ENGINES).map(async ([n, fn]) => {
      try {
        return { n, r: await fn(q, cfg, undefined) };
      } catch (e) {
        return { n, r: { status: "error", reason: String(e?.message ?? e) } };
      }
    })
  );
  const sets = new Map();
  for (const { n, r } of settled) {
    const extra = r.reason ? ` — ${r.reason}` : r.results?.length ? ` (${r.results.length})` : "";
    console.log(`  ${n}: ${r.status}${extra}`);
    if (r.status === "ok" && r.results.length) sets.set(n, r.results);
    for (const s of r.results?.slice(0, 3) ?? []) console.log(`     - ${s.title ?? s.url}`);
  }
  if (sets.size > 0) {
    console.log("  merged (RRF):");
    for (const [i, s] of mergeResults(sets, cfg, q).slice(0, 8).entries())
      console.log(`    ${i + 1}. [${s.engines.map((x) => x.engine).join("+")}] ${s.title ?? s.url}`);
  } else {
    console.log("  merged: (no healthy engine set)");
    failures += 1;
  }
  console.log(`  ${Date.now() - t0}ms`);
}
console.log(failures ? `\n${failures} query(ies) had no healthy engine` : "\nall queries served by at least one healthy engine");
