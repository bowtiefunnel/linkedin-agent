import { AsyncLocalStorage } from "node:async_hooks";
import type { Langfuse } from "langfuse";

/**
 * Per-run observability context, propagated via AsyncLocalStorage so the low-level
 * LLM layer (openrouter) can attach generations + accumulate cost WITHOUT every
 * caller threading a trace parameter. Seeded once at the top of a task run.
 *
 * `cost` is a mutable accumulator: each LLM call adds its usage/cost, and the run
 * writes the total to Supabase at the end (so the app can display spend).
 */
type Trace = ReturnType<Langfuse["trace"]>;

export interface RunObservability {
  traceId: string;
  trace: Trace;
  cost: { usd: number; promptTokens: number; completionTokens: number };
}

const store = new AsyncLocalStorage<RunObservability>();

/** Run `fn` with the given observability context available to all nested calls. */
export function runWithObservability<T>(ctx: RunObservability, fn: () => Promise<T>): Promise<T> {
  return store.run(ctx, fn);
}

/** The current run's observability context, or undefined if not inside one (or Langfuse disabled). */
export const currentObs = (): RunObservability | undefined => store.getStore();
