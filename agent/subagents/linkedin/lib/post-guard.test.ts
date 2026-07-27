import { describe, expect, it } from "vitest";
import { filterPosts, HOOK_MAX_CHARS, type LinkedInPost } from "./post-guard";

const HOOK = "We doubled our pipeline last quarter without touching ad spend.";
const body = (n: number) => "Here is a specific, grounded detail about what actually changed. ".repeat(n).trim();

/** A compliant post: hook first, 3 paragraphs, ~500 chars, none over 350. */
const clean = (over: Partial<LinkedInPost> = {}): LinkedInPost => ({
  hook: HOOK,
  angle: "lesson",
  text: `${HOOK}\n\n${body(4)}\n\n${body(3)}`,
  ...over,
});

describe("filterPosts", () => {
  it("keeps a compliant post", () => {
    const { kept, dropped } = filterPosts([clean()]);
    expect(dropped).toHaveLength(0);
    expect(kept).toHaveLength(1);
  });

  it("drops a wall of text; other posts survive", () => {
    const wall = clean({ text: `${HOOK} ${body(8)}`, angle: "contrarian" });
    const { kept, dropped } = filterPosts([clean(), wall, clean({ angle: "milestone" })]);
    expect(kept.map((p) => p.angle)).toEqual(["lesson", "milestone"]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.violations.join(" ")).toMatch(/wall of text/i);
  });

  it("drops a post whose text does not begin with the hook (§5a)", () => {
    const { dropped } = filterPosts([clean({ text: `A different opening line.\n\n${body(4)}\n\n${body(3)}` })]);
    expect(dropped[0]!.violations.join(" ")).toMatch(/not the first line/i);
  });

  it("tolerates leading whitespace before the hook", () => {
    const { kept } = filterPosts([clean({ text: `\n  ${HOOK}\n\n${body(4)}\n\n${body(3)}` })]);
    expect(kept).toHaveLength(1);
  });

  it("drops an over-long hook", () => {
    const longHook = "x".repeat(HOOK_MAX_CHARS + 1);
    const { dropped } = filterPosts([clean({ hook: longHook, text: `${longHook}\n\n${body(4)}\n\n${body(3)}` })]);
    expect(dropped[0]!.violations.join(" ")).toMatch(/hook too long/i);
  });

  it("drops a post that is too short to review", () => {
    const { dropped } = filterPosts([clean({ text: `${HOOK}\n\nShort.\n\nAlso short.` })]);
    expect(dropped[0]!.violations.join(" ")).toMatch(/too short/i);
  });

  it("drops a post with one over-long paragraph", () => {
    const { dropped } = filterPosts([clean({ text: `${HOOK}\n\n${body(7)}\n\n${body(3)}` })]);
    expect(dropped[0]!.violations.join(" ")).toMatch(/paragraph 2 too long/i);
  });

  it("drops empty text and empty hooks", () => {
    const { dropped } = filterPosts([clean({ text: "   " }), clean({ hook: "" })]);
    expect(dropped).toHaveLength(2);
    expect(dropped[0]!.violations.join(" ")).toMatch(/empty post/i);
    expect(dropped[1]!.violations.join(" ")).toMatch(/empty hook/i);
  });
});
