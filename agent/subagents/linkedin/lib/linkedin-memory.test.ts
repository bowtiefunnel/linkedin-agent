import { describe, expect, it } from "vitest";
import { foldLinkedInMemory, memoryBlock, type LinkedInCardRow } from "./linkedin-memory";

/**
 * The fold/confidence/idempotency logic is shared with the X agent and covered by
 * x-memory.test.ts. What's LinkedIn-specific — and tested here — is reading `text`
 * out of the payload and the channel wording of the prompt block.
 */

const row = (over: Partial<LinkedInCardRow> & { status: string }): LinkedInCardRow => ({
  payload: {},
  created_at: "2026-07-14T13:15:00Z",
  ...over,
});

describe("foldLinkedInMemory", () => {
  it("reads the single `text` payload, with angle and deny reason", () => {
    const mem = foldLinkedInMemory([
      row({ status: "rejected", payload: { text: "A post that missed", angle: "contrarian", denyReason: "too preachy" } }),
      row({ status: "approved", payload: { text: "A post that landed", angle: "lesson" } }),
      row({ status: "pending", payload: { text: "Undecided", angle: "milestone" } }),
    ]);
    expect(mem.rejected).toEqual([{ text: "A post that missed", angle: "contrarian", reason: "too preachy" }]);
    expect(mem.approved).toEqual([{ text: "A post that landed", angle: "lesson" }]);
    expect(mem.confidence).toEqual({ approved: 1, denied: 1, decided: 2, rate: 0.5 });
  });

  it("skips rows carrying no post text (X's thread array is not a LinkedIn shape)", () => {
    const mem = foldLinkedInMemory([row({ status: "approved", payload: { texts: ["seg one"], angle: "lesson" } })]);
    expect(mem.approved).toHaveLength(0);
    expect(mem.confidence.decided).toBe(0);
  });
});

describe("memoryBlock", () => {
  it("names the channel so the steer reads as LinkedIn, not tweets", () => {
    const block = memoryBlock(
      foldLinkedInMemory([row({ status: "rejected", payload: { text: "Bad post", angle: "promo", denyReason: "too salesy" } })]),
    );
    expect(block).toContain("REJECTED LinkedIn posts");
    expect(block).toContain('“Bad post” — reason: "too salesy"');
  });

  it("is empty when there is no history", () => {
    expect(memoryBlock(foldLinkedInMemory([]))).toBe("");
  });
});
