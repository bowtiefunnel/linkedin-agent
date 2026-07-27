import { Langfuse } from "langfuse";

/**
 * Langfuse — LLM observability client. Best-effort by design: if the keys are unset
 * the whole layer is disabled and every caller no-ops, so an agent run never depends
 * on Langfuse being reachable.
 *
 * Env: LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, and the base URL from LANGFUSE_BASEURL
 * (JS SDK name) or LANGFUSE_HOST (Python SDK name) — either works. Defaults to Cloud.
 */
let _client: Langfuse | null | undefined;

export function langfuse(): Langfuse | null {
  if (_client !== undefined) return _client;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) {
    _client = null; // disabled — no keys
    return null;
  }
  const baseUrl = process.env.LANGFUSE_BASEURL ?? process.env.LANGFUSE_HOST ?? "https://cloud.langfuse.com";
  _client = new Langfuse({ publicKey, secretKey, baseUrl });
  return _client;
}

/** Flush queued events before a short-lived Trigger.dev container exits. Safe no-op if disabled. */
export async function flushLangfuse(): Promise<void> {
  try {
    await _client?.flushAsync();
  } catch {
    /* observability must never break a run */
  }
}
