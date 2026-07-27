import { describe, expect, it, vi, beforeEach } from "vitest";

// Chainable Supabase query stub. Each test queues the rows the final await resolves to.
function makeChain(rows: unknown) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit"]) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (res: (v: unknown) => void) => res({ data: rows, error: null });
  return chain;
}

const fromMock = vi.fn();
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: fromMock }) }));

beforeEach(() => {
  process.env.SUPABASE_URL = "http://x";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "k";
  fromMock.mockReset();
});

import { getLastWeekMemory, foldGeoMemory } from "./supabase";

describe("foldGeoMemory", () => {
  const pending = (title: string) => ({ status: "pending", payload: { title } });

  it("counts a repeatedly-undecided fix as ignored, ranked by weeks passed over", () => {
    const m = foldGeoMemory([pending("Add llms.txt"), pending("Add llms.txt"), pending("Ship FAQ schema")]);
    expect(m.ignored).toEqual([
      { title: "Add llms.txt", times: 2 },
      { title: "Ship FAQ schema", times: 1 },
    ]);
  });

  it("does not treat a decided fix as ignored, even with pending rows from other weeks", () => {
    const m = foldGeoMemory([
      pending("Add llms.txt"),
      { status: "rejected", payload: { title: "Add llms.txt", denyReason: "host won't allow it" } },
      pending("Ship FAQ schema"),
      { status: "approved", payload: { title: "Ship FAQ schema" } },
    ]);
    expect(m.ignored).toEqual([]);
    expect(m.rejected).toEqual([{ title: "Add llms.txt", reason: "host won't allow it" }]);
    expect(m.approvedTitles).toEqual(["Ship FAQ schema"]);
  });

  it("skips rows with no title and defaults a missing deny reason", () => {
    const m = foldGeoMemory([{ status: "pending", payload: {} }, { status: "rejected", payload: { title: "X" } }]);
    expect(m.ignored).toEqual([]);
    expect(m.rejected).toEqual([{ title: "X", reason: "" }]);
  });
});

describe("getLastWeekMemory", () => {
  it("returns prior score and maps fix decisions (done→approved)", async () => {
    fromMock.mockReturnValueOnce(
      makeChain([
        { payload: { kind: "weekly-report", score: 91 } },
        { payload: { title: "Fix meta" }, status: "rejected" },
        { payload: { title: "Add alt text" }, status: "done" },
        { payload: { title: "Old idea" }, status: "archived" },
      ]),
    );

    const m = await getLastWeekMemory("acme");
    expect(m.prevScore).toBe(91);
    expect(m.rejectedTitles).toEqual(["Fix meta"]);
    expect(m.prevFixes).toEqual([
      { title: "Fix meta", category: "", decision: "rejected" },
      { title: "Add alt text", category: "", decision: "approved" },
      { title: "Old idea", category: "", decision: "skipped" },
    ]);
  });

  it("maps an explicit \"approved\" status to approved", async () => {
    fromMock.mockReturnValueOnce(makeChain([{ payload: { title: "Fix meta" }, status: "approved" }]));
    const m = await getLastWeekMemory("acme");
    expect(m.prevFixes).toEqual([{ title: "Fix meta", category: "", decision: "approved" }]);
  });

  it("returns null score when rows exist but none is a weekly-report", async () => {
    fromMock.mockReturnValueOnce(makeChain([{ payload: { title: "Fix meta" }, status: "done" }]));
    const m = await getLastWeekMemory("acme");
    expect(m.prevScore).toBeNull();
  });

  it("returns null score and empty lists on the first ever run", async () => {
    fromMock.mockReturnValueOnce(makeChain([]));
    const m = await getLastWeekMemory("acme");
    expect(m).toEqual({ prevScore: null, prevFixes: [], rejectedTitles: [], rejected: [] });
  });
});
