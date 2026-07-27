import { z } from "zod";

/**
 * Shared Zod schemas for the Okara agent suite. Trigger.dev `schemaTask`s validate
 * their payloads against these; agents write `Card`s shaped by `CardPayload`.
 */

/** Config version — bump when scoring/prompt logic changes in a breaking way. */
export const CONFIG_VERSION = "v1";

/* ── Project & Company context ─────────────────────────────────────────────── */

/**
 * The "Company docs" every agent draws from — Okara builds these once from a site
 * scrape (product profile, brand voice, competitor analysis, strategy).
 */
export const CompanyContext = z.object({
  productProfile: z.string(),
  brandVoice: z.string(),
  competitors: z.array(z.string()).default([]),
  strategy: z.string(),
  targetKeywords: z.array(z.string()).default([]),
  audience: z.string().default(""),
});
export type CompanyContext = z.infer<typeof CompanyContext>;

export const Project = z.object({
  projectId: z.string(),
  url: z.string().url(),
  name: z.string(),
  context: CompanyContext,
});
export type Project = z.infer<typeof Project>;

/* ── Cards (Okara's "Agents Feed") ─────────────────────────────────────────── */

export const CardType = z.enum([
  "SEO Recommendation",
  "X Post",
  "GEO Recommendation",
  "Reddit Thread",
  "LinkedIn Post",
  "Article",
  "HN Pitch",
  "UGC Video",
  "Coding PR",
]);
export type CardType = z.infer<typeof CardType>;

export const CardStatus = z.enum(["pending", "approved", "rejected", "archived", "done"]);
export type CardStatus = z.infer<typeof CardStatus>;

export const Card = z.object({
  id: z.string().optional(),
  projectId: z.string(),
  agent: z.string(),
  type: CardType,
  status: CardStatus.default("pending"),
  /** Free-form per-card payload (the draft, metadata, severity, etc.). */
  payload: z.record(z.unknown()),
});
export type Card = z.infer<typeof Card>;

/* ── HITL review decision ──────────────────────────────────────────────────── */

export const ReviewDecision = z.object({
  status: z.enum(["approved", "rejected", "edited", "skipped"]),
  notes: z.string().optional(),
  /** Operator-edited content (when status === "edited"). */
  editedText: z.string().optional(),
});
export type ReviewDecision = z.infer<typeof ReviewDecision>;

/* ── Per-agent payloads (the `.trigger()` inputs) ──────────────────────────── */

/** Common base — every agent runs against one project. */
export const AgentPayload = z.object({
  project: Project,
});
export type AgentPayload = z.infer<typeof AgentPayload>;

/** On-demand agents (HN, UGC) can carry a free-text instruction from chat. */
export const ChatAgentPayload = AgentPayload.extend({
  instruction: z.string().default(""),
});
export type ChatAgentPayload = z.infer<typeof ChatAgentPayload>;

/** UGC editor parameters (mirrors Okara's editor sheet). */
export const UgcParams = z.object({
  aspectRatio: z.enum(["9:16", "16:9", "1:1"]).default("9:16"),
  resolution: z.enum(["480p", "720p"]).default("720p"),
  durationSec: z.number().int().min(3).max(30).default(12),
  audio: z.boolean().default(true),
});
export type UgcParams = z.infer<typeof UgcParams>;

export const UgcPayload = ChatAgentPayload.extend({
  params: UgcParams.default({}),
});
export type UgcPayload = z.infer<typeof UgcPayload>;

/** Coding agent is fired by the SEO agent with a concrete code-level fix. */
export const CodingPayload = AgentPayload.extend({
  fix: z.object({
    title: z.string(),
    description: z.string(),
    file: z.string().optional(),
    severity: z.enum(["low", "medium", "high"]).default("medium"),
  }),
});
export type CodingPayload = z.infer<typeof CodingPayload>;
