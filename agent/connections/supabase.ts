import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Card, CardStatus, CardType, Project, CompanyContext } from "../schemas";

/**
 * Supabase — REAL integration. Backing store for:
 *   - projects        — one "AI CMO" per site (url + Company context docs)
 *   - cards           — typed agent output (Okara's Agents Feed)
 *   - audit_log       — what each agent did
 *   - review_requests — HITL token → Slack location
 *
 * DDL lives in supabase/schema.sql.
 */

let _client: SupabaseClient | null = null;

function db(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

/* ── Cards (Agents Feed) ───────────────────────────────────────────────────── */

/** Insert a pending card and return its id. */
export async function insertCard(card: Card): Promise<string> {
  const { data, error } = await db()
    .from("cards")
    .insert({
      project_id: card.projectId,
      agent: card.agent,
      type: card.type,
      status: card.status ?? "pending",
      payload: card.payload,
    })
    .select("id")
    .single();
  if (error) throw new Error(`insertCard: ${error.message}`);
  return String((data as { id: string }).id);
}

/** Insert several cards at once (e.g. SEO emits one card per fix). */
export async function insertCards(cards: Card[]): Promise<string[]> {
  if (cards.length === 0) return [];
  const { data, error } = await db()
    .from("cards")
    .insert(
      cards.map((c) => ({
        project_id: c.projectId,
        agent: c.agent,
        type: c.type,
        status: c.status ?? "pending",
        payload: c.payload,
      })),
    )
    .select("id");
  if (error) throw new Error(`insertCards: ${error.message}`);
  return (data as Array<{ id: string }>).map((d) => String(d.id));
}

/**
 * Recent cards of one type for a project, newest first — one read that serves an
 * agent's memory fold, confidence tally, and same-day idempotency check.
 */
export async function listRecentCards(
  projectId: string,
  type: CardType,
  limit = 60,
): Promise<Array<{ payload: Record<string, unknown>; status: string; created_at: string }>> {
  const { data, error } = await db()
    .from("cards")
    .select("payload,status,created_at")
    .eq("project_id", projectId)
    .eq("type", type)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listRecentCards: ${error.message}`);
  return (data as Array<{ payload: Record<string, unknown>; status: string; created_at: string }> | null) ?? [];
}

export async function updateCardStatus(id: string, status: CardStatus): Promise<void> {
  const { error } = await db().from("cards").update({ status }).eq("id", id);
  if (error) throw new Error(`updateCardStatus: ${error.message}`);
}

/**
 * Merge a deny reason (and decider) into a card's payload, preserving existing keys.
 * Read-modify-write — fine for HITL's low volume. Pairs with status="rejected".
 */
export async function setCardDenyReason(id: string, reason: string, decidedBy?: string): Promise<void> {
  const { data, error: readErr } = await db().from("cards").select("payload").eq("id", id).single();
  if (readErr) throw new Error(`setCardDenyReason(read): ${readErr.message}`);
  const payload = { ...((data?.payload as Record<string, unknown>) ?? {}), denyReason: reason, ...(decidedBy ? { decidedBy } : {}) };
  const { error } = await db().from("cards").update({ payload }).eq("id", id);
  if (error) throw new Error(`setCardDenyReason(write): ${error.message}`);
}

/* ── Audit log ─────────────────────────────────────────────────────────────── */

export async function auditLog(input: {
  agent: string;
  projectId?: string;
  action: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const { error } = await db().from("audit_log").insert({
    agent: input.agent,
    project_id: input.projectId,
    action: input.action,
    detail: input.detail ?? {},
  });
  if (error) throw new Error(`auditLog: ${error.message}`);
}

/* ── Review requests (HITL) ────────────────────────────────────────────────── */

export async function recordReviewRequest(input: {
  agent: string;
  projectId?: string;
  tokenId: string;
  tokenUrl: string;
  kind: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const { error } = await db().from("review_requests").insert({
    agent: input.agent,
    project_id: input.projectId,
    token_id: input.tokenId,
    token_url: input.tokenUrl,
    kind: input.kind,
    payload: input.payload ?? {},
  });
  if (error) throw new Error(`recordReviewRequest: ${error.message}`);
}

/* ── Storage (report files) ────────────────────────────────────────────────── */

/**
 * Upload an HTML report to Supabase Storage (PRIVATE bucket) and return a time-limited
 * signed URL that renders in the browser. The report is NOT world-readable — only holders
 * of the signed link can open it, and it expires. The bucket is created (private) on first
 * use. Override the bucket via REPORTS_BUCKET and the link lifetime via
 * REPORT_URL_TTL_SECONDS (default 30 days).
 */
export async function uploadReportHtml(path: string, html: string): Promise<string> {
  const client = db();
  const bucket = process.env.REPORTS_BUCKET ?? "reports";
  const ttl = Number(process.env.REPORT_URL_TTL_SECONDS ?? 60 * 60 * 24 * 30);

  const { data: buckets } = await client.storage.listBuckets();
  if (!buckets?.some((b) => b.name === bucket)) {
    const { error: be } = await client.storage.createBucket(bucket, { public: false });
    if (be && !/already exists|duplicate/i.test(be.message)) throw new Error(`createBucket: ${be.message}`);
  }
  const { error } = await client.storage.from(bucket).upload(path, Buffer.from(html, "utf8"), {
    contentType: "text/html; charset=utf-8",
    upsert: true,
  });
  if (error) throw new Error(`uploadReportHtml: ${error.message}`);

  // Serve via a download link. Supabase serves HTML from signed URLs as text/plain
  // + nosniff (anti-XSS on the storage domain), so an inline link shows source, not a
  // rendered page. `download` sets Content-Disposition: attachment so the click saves a
  // real .html file that renders when opened. Name it from the path (e.g.
  // "seo/<project>/2026-06-28.html" → "seo-<project>-2026-06-28.html").
  const downloadName = path.replace(/\//g, "-");
  const { data, error: se } = await client.storage
    .from(bucket)
    .createSignedUrl(path, ttl, { download: downloadName });
  if (se || !data?.signedUrl) throw new Error(`createSignedUrl: ${se?.message ?? "no url"}`);
  return data.signedUrl;
}

/* ── Projects ──────────────────────────────────────────────────────────────── */

/** All projects (for scheduled fan-out, e.g. the weekly SEO report). */
export async function listProjects(): Promise<Project[]> {
  const { data, error } = await db().from("projects").select("project_id, url, name, context");
  if (error) throw new Error(`listProjects: ${error.message}`);
  return (data as Array<{ project_id: string; url: string; name: string; context: CompanyContext }>).map((r) => ({
    projectId: r.project_id,
    url: r.url,
    name: r.name,
    context: r.context,
  }));
}

export async function upsertProject(input: {
  projectId: string;
  url: string;
  name: string;
  context: Record<string, unknown>;
}): Promise<void> {
  const { error } = await db()
    .from("projects")
    .upsert(
      {
        project_id: input.projectId,
        url: input.url,
        name: input.name,
        context: input.context,
      },
      { onConflict: "project_id" },
    );
  if (error) throw new Error(`upsertProject: ${error.message}`);
}

/* ── Cross-run memory (structured, exact — Supabase only) ──────────────────── */

export interface LastWeekMemory {
  prevScore: number | null;
  prevFixes: Array<{ title: string; category: string; decision: "approved" | "rejected" | "skipped" }>;
  rejectedTitles: string[];
  /** Rejected fixes paired with the reviewer's typed reason — the strongest steer for next week. */
  rejected: Array<{ title: string; reason: string }>;
}

/**
 * Exact structured recall for the weekly SEO agent: the prior run's overall score
 * (for week-over-week deltas) and the prior per-fix decisions (for the
 * "do not re-recommend" list). Reads existing `cards` rows — no new tables, no writes.
 */
export async function getLastWeekMemory(projectId: string): Promise<LastWeekMemory> {
  const client = db();

  const { data: rows, error } = await client
    .from("cards")
    .select("payload,status")
    .eq("project_id", projectId)
    .eq("type", "SEO Recommendation")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(`getLastWeekMemory: ${error.message}`);

  const all =
    (rows as Array<{
      payload: { kind?: string; score?: number; title?: string; category?: string; denyReason?: string };
      status: string;
    }> | null) ?? [];

  const reportCard = all.find((r) => r.payload?.kind === "weekly-report");
  const prevScore = typeof reportCard?.payload?.score === "number" ? reportCard.payload.score : null;

  // approved fixes are stored as "done"; rejected as "rejected"; skipped/timeout as "archived".
  const decisionOf = (status: string): "approved" | "rejected" | "skipped" =>
    status === "done" || status === "approved" ? "approved" : status === "rejected" ? "rejected" : "skipped";

  const decided = all
    .filter((r) => typeof r.payload?.title === "string")
    .map((r) => ({
      title: r.payload.title as string,
      category: r.payload.category ?? "",
      reason: r.payload.denyReason ?? "",
      decision: decisionOf(r.status),
    }));

  const prevFixes = decided.map(({ title, category, decision }) => ({ title, category, decision }));
  const rejected = decided.filter((f) => f.decision === "rejected").map(({ title, reason }) => ({ title, reason }));
  const rejectedTitles = rejected.map((f) => f.title);

  return { prevScore, prevFixes, rejectedTitles, rejected };
}

/**
 * Cumulative LLM spend for a project's SEO agent — summed from the `costUsd` written
 * on each run's weekly-report card. This is the app's cost read (no Langfuse dependency).
 */
export async function getProjectCost(projectId: string): Promise<{ totalUsd: number; runs: number }> {
  const { data, error } = await db()
    .from("cards")
    .select("payload")
    .eq("project_id", projectId)
    .eq("type", "SEO Recommendation")
    .eq("payload->>kind", "weekly-report");
  if (error) throw new Error(`getProjectCost: ${error.message}`);
  const rows = (data as Array<{ payload: { costUsd?: number } }> | null) ?? [];
  const totalUsd = rows.reduce((sum, r) => sum + (typeof r.payload?.costUsd === "number" ? r.payload.costUsd : 0), 0);
  return { totalUsd, runs: rows.length };
}

export interface AgentConfidence {
  runs: number; // weekly reports produced
  approved: number;
  denied: number;
  pending: number;
  /** approved / (approved + denied), 0..1 — null until at least one decision exists. */
  rate: number | null;
}

/**
 * Approval-rate confidence for one project's SEO agent over its full history:
 * how often the reviewer accepts what the agent proposes. Pending (undecided)
 * fixes are excluded from the rate but reported separately. Reads `cards` only.
 */
export async function getAgentConfidence(projectId: string): Promise<AgentConfidence> {
  const client = db();
  const { data: rows, error } = await client
    .from("cards")
    .select("payload,status")
    .eq("project_id", projectId)
    .eq("type", "SEO Recommendation");
  if (error) throw new Error(`getAgentConfidence: ${error.message}`);

  const all = (rows as Array<{ payload: { kind?: string; title?: string }; status: string }> | null) ?? [];
  const runs = all.filter((r) => r.payload?.kind === "weekly-report").length;
  const fixes = all.filter((r) => typeof r.payload?.title === "string");
  const approved = fixes.filter((r) => r.status === "approved" || r.status === "done").length;
  const denied = fixes.filter((r) => r.status === "rejected").length;
  const pending = fixes.filter((r) => r.status === "pending").length;
  const decided = approved + denied;

  return { runs, approved, denied, pending, rate: decided ? approved / decided : null };
}

/* ── GEO agent (own tables) ────────────────────────────────────────────────── */

export interface GeoEngineScore {
  engine: string;
  score: number | null; // null = engine unavailable this run
  mentioned: number; // # of panel questions where the brand appeared
  cited: number;
  asked: number;
}

export interface GeoRunInput {
  projectId: string;
  runDate: string; // YYYY-MM-DD
  overallScore: number | null;
  engineScores: GeoEngineScore[];
  competitors: Array<{ name: string; mentions: number }>;
  fixes: Array<{ title: string; category: string }>;
  /** Sites grounded AI answers cited this week (placement targets). */
  citationSources?: Array<{ domain: string; count: number }>;
  /** Brand-sentiment tallies + evidence quotes (null = classifier unavailable). */
  sentiment?: Record<string, unknown> | null;
  /** AI readiness checklist (llms.txt/robots/sitemap/schema booleans). */
  aiReadiness?: Record<string, boolean> | null;
  reportPath: string; // durable storage key — signed URLs are minted from this
  reportUrl: string; // signed link (expires; convenience for the Slack post)
  costUsd?: number;
  traceId?: string;
}

/** Read the stable question panel for a project (null if not generated yet). */
export async function getGeoPanel(projectId: string): Promise<string[] | null> {
  const { data, error } = await db().from("geo_panels").select("questions").eq("project_id", projectId).maybeSingle();
  if (error) throw new Error(`getGeoPanel: ${error.message}`);
  const q = (data as { questions?: unknown } | null)?.questions;
  return Array.isArray(q) ? (q as string[]) : null;
}

/** Create or replace a project's question panel. */
export async function upsertGeoPanel(projectId: string, questions: string[]): Promise<void> {
  const { error } = await db()
    .from("geo_panels")
    .upsert({ project_id: projectId, questions, updated_at: new Date().toISOString() }, { onConflict: "project_id" });
  if (error) throw new Error(`upsertGeoPanel: ${error.message}`);
}

/**
 * UPSERT the weekly run record on (project_id, run_date) and return its id. A run
 * that crashed and retried replaces its own row instead of duplicating the week; we
 * then clear that run's old geo_fixes so the caller re-inserts them (idempotent retry).
 */
export async function insertGeoRun(run: GeoRunInput): Promise<string> {
  const { data, error } = await db()
    .from("geo_runs")
    .upsert(
      {
        project_id: run.projectId,
        run_date: run.runDate,
        overall_score: run.overallScore,
        engine_scores: run.engineScores,
        competitors: run.competitors,
        fixes: run.fixes,
        citation_sources: run.citationSources ?? [],
        sentiment: run.sentiment ?? {},
        ai_readiness: run.aiReadiness ?? {},
        report_path: run.reportPath,
        report_url: run.reportUrl,
        cost_usd: run.costUsd ?? null,
        trace_id: run.traceId ?? null,
      },
      { onConflict: "project_id,run_date" },
    )
    .select("id")
    .single();
  if (error) throw new Error(`insertGeoRun: ${error.message}`);
  const runId = String((data as { id: number }).id);
  // Idempotent retry: drop any fixes a crashed earlier attempt staged for this run.
  const { error: delErr } = await db().from("geo_fixes").delete().eq("run_id", Number(runId));
  if (delErr) throw new Error(`insertGeoRun(clear fixes): ${delErr.message}`);
  return runId;
}

/** Prior run's overall score, for the week-over-week delta (null if first run). */
export async function getLastGeoRun(projectId: string): Promise<{ overallScore: number | null } | null> {
  const { data, error } = await db()
    .from("geo_runs")
    .select("overall_score")
    .eq("project_id", projectId)
    .order("run_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getLastGeoRun: ${error.message}`);
  if (!data) return null;
  const s = (data as { overall_score: number | null }).overall_score;
  return { overallScore: typeof s === "number" ? s : null };
}

/** Insert one pending fix decision row; returns its id (used as the Slack button value). */
export async function insertGeoFix(input: {
  projectId: string;
  runId: string;
  payload: Record<string, unknown>;
}): Promise<string> {
  const { data, error } = await db()
    .from("geo_fixes")
    .insert({ project_id: input.projectId, run_id: Number(input.runId), status: "pending", payload: input.payload })
    .select("id")
    .single();
  if (error) throw new Error(`insertGeoFix: ${error.message}`);
  return String((data as { id: number }).id);
}

export interface GeoMemory {
  rejected: Array<{ title: string; reason: string }>;
  rejectedTitles: string[];
  /** Approved but possibly not yet implemented — don't blindly re-propose. */
  approvedTitles: string[];
  /**
   * Proposed but never decided, and never decided in ANY week. `times` = how many
   * weeks it was put in front of the reviewer and passed over. Repeated silence is
   * a soft no: the fix isn't wrong, but it keeps losing to everything else.
   */
  ignored: Array<{ title: string; times: number }>;
}

export interface GeoFixRow {
  payload: { title?: string; denyReason?: string };
  status: string;
}

/**
 * Fold decided + undecided geo_fixes rows into the learning ledger. Pure, so the
 * three-way status logic is testable without a database.
 */
export function foldGeoMemory(rows: GeoFixRow[]): GeoMemory {
  const titled = rows.filter((r) => typeof r.payload?.title === "string");
  const rejected = titled
    .filter((r) => r.status === "rejected")
    .map((r) => ({ title: r.payload.title as string, reason: r.payload.denyReason ?? "" }));
  const approvedTitles = titled.filter((r) => r.status === "approved").map((r) => r.payload.title as string);

  // A title decided in ANY week is not "ignored" — the operator has ruled on it,
  // so its still-pending rows from other weeks carry no additional signal.
  const decided = new Set<string>([...rejected.map((r) => r.title), ...approvedTitles]);
  const pendingCounts = new Map<string, number>();
  for (const r of titled) {
    const title = r.payload.title as string;
    if (r.status !== "pending" || decided.has(title)) continue;
    pendingCounts.set(title, (pendingCounts.get(title) ?? 0) + 1);
  }
  const ignored = [...pendingCounts.entries()]
    .map(([title, times]) => ({ title, times }))
    .sort((a, b) => b.times - a.times || a.title.localeCompare(b.title));

  return { rejected, rejectedTitles: rejected.map((r) => r.title), approvedTitles, ignored };
}

/**
 * The learning loop: all THREE reviewer behaviours from prior runs. Rejected fixes +
 * the reviewer's reason (never re-recommend; avoid the failure mode), approved fixes
 * (already accepted/in progress — don't re-propose unless still broken), and fixes
 * left undecided week after week (a soft no — see `ignored`). Reads geo_fixes only.
 */
export async function getLastGeoMemory(projectId: string): Promise<GeoMemory> {
  const { data, error } = await db()
    .from("geo_fixes")
    .select("payload,status")
    .eq("project_id", projectId)
    .in("status", ["rejected", "approved", "pending"])
    // ponytail: ~12 weeks at 5 fixes/wk. Raise if the ledger ever outgrows the window.
    .limit(60)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`getLastGeoMemory: ${error.message}`);
  return foldGeoMemory((data as GeoFixRow[] | null) ?? []);
}
