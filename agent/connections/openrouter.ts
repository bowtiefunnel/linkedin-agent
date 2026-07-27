/**
 * OpenRouter — REAL integration. The LLM brain for every agent.
 *
 * OpenRouter is OpenAI-compatible, so we call `/chat/completions` directly with
 * fetch (no SDK). Two entry points:
 *   - generateStructured<T>() — schema-constrained JSON (drafts, scores, relevance).
 *   - generateText()          — free-form long-form (the Writer agent's articles).
 *
 * Model defaults to OPENROUTER_MODEL; any call can override via `opts.model`.
 */

import { currentObs } from "../lib/trace";

const BASE_URL = "https://openrouter.ai/api/v1/chat/completions";

// Claude is the primary reasoning model (via OpenRouter). If it errors or returns
// empty (quota, outage, refusal), we automatically fall back to a different LLM so the
// agent still produces output. Override either via env.
const PRIMARY_MODEL = process.env.OPENROUTER_MODEL ?? "anthropic/claude-3.5-sonnet";
const FALLBACK_MODEL = process.env.OPENROUTER_FALLBACK_MODEL ?? "openai/gpt-4o-mini";

function apiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY must be set");
  return key;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface CompletionOpts {
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ChatResult {
  content: string;
  /** Source URLs cited by grounded models (Perplexity etc.); empty for most models. */
  citations: string[];
}

/** One attempt against a specific model. Throws on HTTP error or empty content. */
async function callModel(
  model: string,
  messages: ChatMessage[],
  opts: CompletionOpts & { responseFormat?: Record<string, unknown> },
): Promise<ChatResult> {
  // Log this call as a Langfuse generation under the current run's trace (if any).
  const obs = currentObs();
  const gen = obs?.trace.generation({ name: model, model, input: messages });
  try {
    const res = await fetch(BASE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://bowtiefunnel.com",
        "X-Title": "Bowtie Funnel Agents (Trigger.dev)",
      },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens ?? 4096,
        temperature: opts.temperature ?? 0.7,
        messages,
        usage: { include: true }, // OpenRouter returns real USD cost in `usage.cost`
        ...(opts.responseFormat ? { response_format: opts.responseFormat } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenRouter ${res.status} (${model}): ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      citations?: unknown; // Perplexity via OpenRouter: root-level array of source URLs
      choices?: Array<{
        message?: {
          content?: string;
          annotations?: Array<{ type?: string; url_citation?: { url?: string } }>;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error(`OpenRouter returned no content (${model})`);

    // Source citations from grounded models (Perplexity et al). Two shapes exist:
    // legacy root-level `citations: string[]` and OpenAI-style url_citation annotations.
    const citations: string[] = [];
    if (Array.isArray(data.citations)) {
      for (const c of data.citations) if (typeof c === "string") citations.push(c);
    }
    for (const a of data.choices?.[0]?.message?.annotations ?? []) {
      const u2 = a?.url_citation?.url;
      if (typeof u2 === "string") citations.push(u2);
    }

    const u = data.usage ?? {};
    gen?.end({ output: content, usage: { input: u.prompt_tokens, output: u.completion_tokens, totalCost: u.cost } });
    if (obs) {
      obs.cost.usd += u.cost ?? 0;
      obs.cost.promptTokens += u.prompt_tokens ?? 0;
      obs.cost.completionTokens += u.completion_tokens ?? 0;
    }
    return { content, citations };
  } catch (err) {
    gen?.end({ level: "ERROR", statusMessage: String(err).slice(0, 200) });
    throw err;
  }
}

/**
 * Try the primary (Claude) model, then the fallback LLM if it fails. An explicit
 * `opts.model` skips the fallback chain (caller asked for a specific model, e.g. the
 * GEO agent's per-engine probes).
 */
async function chat(
  messages: ChatMessage[],
  opts: CompletionOpts & { responseFormat?: Record<string, unknown> } = {},
): Promise<ChatResult> {
  const models = opts.model ? [opts.model] : [PRIMARY_MODEL, FALLBACK_MODEL];
  let lastErr: unknown;
  for (let i = 0; i < models.length; i++) {
    try {
      return await callModel(models[i]!, messages, opts);
    } catch (err) {
      lastErr = err;
      if (i < models.length - 1) {
        // eslint-disable-next-line no-console
        console.warn(`[openrouter] ${models[i]} failed, falling back to ${models[i + 1]}: ${String(err)}`);
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("OpenRouter: all models failed");
}

/** Free-form text generation (long-form articles, etc.). */
export async function generateText(opts: {
  system: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<string> {
  return (await generateTextWithCitations(opts)).content;
}

/**
 * Free-form generation that ALSO returns the source URLs the model cited (grounded
 * models like Perplexity Sonar). Non-grounded models return an empty citations array.
 * Used by the GEO agent to build the weekly "top citation sources" leaderboard.
 */
export async function generateTextWithCitations(opts: {
  system: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<ChatResult> {
  return chat(
    [
      { role: "system", content: opts.system },
      { role: "user", content: opts.prompt },
    ],
    { model: opts.model, maxTokens: opts.maxTokens, temperature: opts.temperature },
  );
}

/**
 * Schema-constrained generation. Returns parsed JSON of type T. Uses OpenRouter's
 * `response_format: json_schema` where the model supports it; falls back to parsing
 * the first JSON object found if a model wraps it in prose.
 */
export async function generateStructured<T>(opts: {
  system: string;
  prompt: string;
  schema: Record<string, unknown>; // JSON Schema (object, additionalProperties:false)
  schemaName?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<T> {
  // response_format: json_schema is honored only by some providers (e.g. OpenAI).
  // Anthropic models served via Bedrock IGNORE it and return markdown prose, which
  // breaks parsing. They DO reliably emit clean JSON when the prompt demands it, so
  // we also instruct JSON-only in the system message and inline the schema. Belt and
  // suspenders: providers that honor response_format still get the hard constraint.
  const jsonInstruction =
    "\n\nIMPORTANT: Respond with ONLY a single valid JSON object that conforms exactly " +
    "to this JSON Schema. No markdown, no code fences, no commentary before or after — " +
    "just the raw JSON object.\n\nJSON Schema:\n" +
    JSON.stringify(opts.schema);

  const raw = await chat(
    [
      { role: "system", content: opts.system + jsonInstruction },
      { role: "user", content: opts.prompt },
    ],
    {
      model: opts.model,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature ?? 0.4,
      responseFormat: {
        type: "json_schema",
        json_schema: {
          name: opts.schemaName ?? "result",
          strict: true,
          schema: opts.schema,
        },
      },
    },
  );

  return parseJson<T>(raw.content);
}

/** Tolerant JSON parse — handles a clean object, code fences, or one embedded in prose. */
function parseJson<T>(raw: string): T {
  // Strip a leading/trailing ```json … ``` (or plain ```) fence if present.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = (fenced ? fenced[1]! : raw).trim();
  try {
    return JSON.parse(candidate) as T;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1)) as T;
    }
    throw new Error(`OpenRouter returned non-JSON: ${raw.slice(0, 300)}`);
  }
}
