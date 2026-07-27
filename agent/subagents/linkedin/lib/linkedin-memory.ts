import {
  foldDraftMemory,
  draftMemoryBlock,
  hasCardForDay,
  type DraftCardRow,
  type DraftMemory,
} from "../../../lib/draft-memory";

/**
 * LinkedIn agent learning ledger — the shared draft ledger (`shared/lib/draft-memory`)
 * bound to `LinkedIn Post` payloads. Per the spec's §5a convention, `text` is the
 * complete paste-ready post (hook included as its first line), so recall reads it
 * straight: no thread array, no legacy shape.
 */

export type LinkedInCardRow = DraftCardRow;
export type LinkedInMemory = DraftMemory;
export { hasCardForDay };

function draftText(payload: Record<string, unknown>): string | null {
  return typeof payload.text === "string" && payload.text ? payload.text : null;
}

export function foldLinkedInMemory(rows: LinkedInCardRow[]): LinkedInMemory {
  return foldDraftMemory(rows, draftText);
}

/** Render the ledger as the PRIOR CONTEXT prompt block ("" when there's no history). */
export function memoryBlock(mem: LinkedInMemory): string {
  return draftMemoryBlock(mem, "LinkedIn posts");
}
