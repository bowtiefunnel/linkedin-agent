/**
 * Shared draft-agent learning ledger — folds prior card decisions into the steer for
 * the next run. Extracted from x-memory.ts when the LinkedIn agent (its twin) landed;
 * the two differ only in how a draft's text is read out of the payload and in the noun
 * used in the prompt block, so both are parameters.
 *
 * Pure functions: the fold, prompt block, and idempotency check are testable without
 * a database. One `cards` query serves all three reads (memory, confidence, "already
 * ran today").
 */

export interface DraftCardRow {
  payload: Record<string, unknown>;
  status: string;
  created_at?: string;
}

export interface DraftMemory {
  /** Rejected drafts + the operator's typed reason — the strongest steer. */
  rejected: Array<{ text: string; angle: string; reason: string }>;
  /** Recently approved (= posted by operator, per convention) — don't repeat. */
  approved: Array<{ text: string; angle: string }>;
  /** Ledger tallies; rate is null until at least one decision exists. */
  confidence: { approved: number; denied: number; decided: number; rate: number | null };
}

/** Reads one draft's text out of a card payload; null when the row carries no usable draft. */
export type DraftTextReader = (payload: Record<string, unknown>) => string | null;

const APPROVED_LIMIT = 15;

export function foldDraftMemory(rows: DraftCardRow[], textOf: DraftTextReader): DraftMemory {
  const drafts = rows
    .map((r) => ({
      text: textOf(r.payload),
      angle: typeof r.payload.angle === "string" ? r.payload.angle : "",
      row: r,
    }))
    .filter((d): d is { text: string; angle: string; row: DraftCardRow } => d.text !== null);

  const rejected = drafts
    .filter((d) => d.row.status === "rejected")
    .map((d) => ({
      text: d.text,
      angle: d.angle,
      reason: typeof d.row.payload.denyReason === "string" ? d.row.payload.denyReason : "",
    }));
  const approvedAll = drafts.filter((d) => d.row.status === "approved" || d.row.status === "done");
  const approved = approvedAll.slice(0, APPROVED_LIMIT).map(({ text, angle }) => ({ text, angle }));

  const decided = approvedAll.length + rejected.length;
  return {
    rejected,
    approved,
    confidence: {
      approved: approvedAll.length,
      denied: rejected.length,
      decided,
      rate: decided ? approvedAll.length / decided : null,
    },
  };
}

/**
 * Render the ledger as the PRIOR CONTEXT prompt block ("" when there's no history).
 * `noun` is the channel's plural for a draft ("tweets", "LinkedIn posts").
 */
export function draftMemoryBlock(mem: DraftMemory, noun: string): string {
  const clip = (s: string, max = 200) => (s.length > max ? s.slice(0, max - 1) + "…" : s);
  return [
    mem.rejected.length
      ? `Previously REJECTED ${noun} (avoid these angles/topics and whatever made them fail):\n${mem.rejected
          .map((r) => `- [${r.angle}] “${clip(r.text)}”${r.reason ? ` — reason: "${r.reason}"` : ""}`)
          .join("\n")}`
      : "",
    mem.approved.length
      ? `Recently APPROVED ${noun} (already posted — do not repeat these topics or phrasings):\n${mem.approved
          .map((a) => `- [${a.angle}] “${clip(a.text)}”`)
          .join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Idempotency: does any card already exist on this UTC day (YYYY-MM-DD)? */
export function hasCardForDay(rows: DraftCardRow[], dayKey: string): boolean {
  return rows.some((r) => typeof r.created_at === "string" && r.created_at.slice(0, 10) === dayKey);
}
