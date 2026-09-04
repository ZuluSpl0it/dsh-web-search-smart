// Local-LLM rank + summary step: one short ctx.llm turn (this deployment:
// local qwen 3.8 27B, zero external cost) over the merged candidates.
// Strict-JSON contract, fully defensive — any failure returns null and the
// caller falls back to the deterministic RRF order. Search never blocks on
// the model. See docs spec §7.

import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { linkedDeadline } from "./http.js";

const SYSTEM = [
  "You are a search-result filter and summarizer.",
  "You will get a user query and a numbered list of candidate web results.",
  'Respond with EXACTLY one JSON object and nothing else: {"ranked":[...],"answer":"..."}',
  "- ranked: candidate indices (0-based) in order of relevance to the query. Drop indices that are irrelevant or show bot-feed/spam traits (off-topic domain floods, template garbage, language mismatch).",
  "- answer: 2-4 sentences that directly answer the query, citing candidates as [n]. If no candidate is relevant, set ranked to [] and say so in answer.",
].join("\n");

function frame(query, candidates) {
  const lines = candidates.map((c, i) => {
    const head = `${i + 1}. [${i}] ${c.title ?? "(no title)"}`;
    return c.snippet ? `${head}\n   ${c.url}\n   ${c.snippet}` : `${head}\n   ${c.url}`;
  });
  return `Query: ${query}\n\nCandidates:\n${lines.join("\n")}`;
}

/**
 * Defensive parse of the model's response. Accepts the JSON object anywhere in
 * the text (first "{" … last "}"); validates ranked (unique in-range integers)
 * and answer (string, truncated to 500). Returns null on any violation.
 */
export function parseLlmJson(text, n) {
  if (typeof text !== "string" || text.length === 0) return null;
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s === -1 || e <= s) return null;
  let obj;
  try {
    obj = JSON.parse(text.slice(s, e + 1));
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
  if (!Array.isArray(obj.ranked)) return null;
  const seen = new Set();
  const ranked = [];
  for (const x of obj.ranked) {
    if (typeof x !== "number" || !Number.isInteger(x) || x < 0 || x >= n || seen.has(x)) return null;
    seen.add(x);
    ranked.push(x);
  }
  let answer = typeof obj.answer === "string" ? obj.answer.trim() : "";
  if (answer.length > 500) answer = answer.slice(0, 500);
  if (ranked.length === 0 && !answer) return null;
  return { ranked, ...(answer ? { answer } : {}) };
}

function safeCurrentSession(ctx) {
  try {
    return ctx?.get?.("agents")?.currentInitiator?.()?.session;
  } catch {
    return undefined;
  }
}

/**
 * @returns {null | {ranked: number[], answer?: string}} null = use fallback.
 */
export async function rankAndAnswer(ctx, opts, candidates, signal) {
  const llm = ctx?.llm ?? (typeof ctx?.get === "function" ? ctx.get("llm") : undefined);
  if (!llm?.stream || !opts.llmProvider || !opts.llmModel) return null;
  const d = linkedDeadline(signal, opts.llmTimeoutMs, "WEB_LLM_TIMEOUT");
  try {
    const messages = [
      createUserMessage({
        content: [{ type: "text", text: frame(opts.query, candidates) }],
        source: { kind: "plugin", plugin: "dsh-web-search-smart" },
      }),
    ];
    const session = safeCurrentSession(ctx);
    try {
      session?.append?.("web/smart-search-llm-request", {
        query: opts.query,
        candidates: candidates.length,
        route: { provider: opts.llmProvider, model: opts.llmModel },
      });
    } catch {
      /* logging is best-effort */
    }
    const assembler = new BlockAssembler();
    for await (const chunk of llm.stream({
      provider: opts.llmProvider,
      model: opts.llmModel,
      messages,
      system: SYSTEM,
      maxTokens: 1024,
      purpose: "web-search",
      signal: d.signal,
      ...(session ? { sessionId: session.id } : {}),
    })) {
      d.signal.throwIfAborted();
      assembler.push(chunk);
    }
    if (assembler.finish?.kind !== "stop") return null;
    const text = assembler
      .blocks()
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return parseLlmJson(text, candidates.length);
  } catch {
    return null;
  } finally {
    d.dispose();
  }
}
