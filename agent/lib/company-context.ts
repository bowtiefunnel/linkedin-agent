import type { CompanyContext, Project } from "../schemas";

/**
 * The Company context every agent draws from — Okara's "foundation every agent uses."
 * Agents call `contextBlock()` to fold the product profile, brand voice, strategy, and
 * keywords into their prompt, so output stays on-brand and grounded.
 *
 * The orchestrator builds the `CompanyContext` once (from a site scrape) and stores it
 * on the project; agents just read it.
 */

/** Render the company context as a prompt-ready block. */
export function contextBlock(ctx: CompanyContext): string {
  const lines = [
    `Product: ${ctx.productProfile}`,
    `Brand voice: ${ctx.brandVoice}`,
    ctx.audience ? `Audience: ${ctx.audience}` : "",
    ctx.strategy ? `Strategy: ${ctx.strategy}` : "",
    ctx.competitors.length ? `Competitors: ${ctx.competitors.join(", ")}` : "",
    ctx.targetKeywords.length ? `Target keywords: ${ctx.targetKeywords.join(", ")}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

/** Convenience: the system-prompt preamble shared by all content agents. */
export function brandSystemPreamble(project: Project): string {
  return (
    `You are a marketing agent working for ${project.name} (${project.url}). ` +
    `Write in the brand's voice and stay grounded in the company context below. ` +
    `Never invent facts, metrics, or customer names.\n\n` +
    `── Company context ──\n${contextBlock(project.context)}`
  );
}
