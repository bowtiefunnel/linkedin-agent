import { logger, schemaTask, schedules } from "@trigger.dev/sdk";
import { generateStructured } from "../../connections/openrouter";
import { insertCards, auditLog, listProjects, listRecentCards } from "../../connections/supabase";
import { postMessage } from "../../connections/slack";
import { perFixReviewCard } from "../../lib/blocks";
import { brandSystemPreamble } from "../../lib/company-context";
import { AgentPayload, type Project } from "../../schemas";
import { langfuse, flushLangfuse } from "../../connections/langfuse";
import { runWithObservability, currentObs } from "../../lib/trace";
import { foldLinkedInMemory, memoryBlock, hasCardForDay, type LinkedInCardRow } from "./lib/linkedin-memory";
import {
  filterPosts,
  HOOK_MAX_CHARS,
  MIN_PARAGRAPH_BREAKS,
  PARAGRAPH_MAX_CHARS,
  POST_MAX_CHARS,
  POST_MIN_CHARS,
  type LinkedInPost,
} from "./lib/post-guard";

/**
 * Daily LinkedIn Agent — draft-only (replaces the retired waitpoint-era stub).
 * The X agent's shell with a different prompt, format, and guardrail numbers: that
 * sameness is the composability proof, not an accident. Once a day per project:
 *   1. same-day idempotency check (a crashed re-run must not duplicate cards or
 *      re-ping Slack), then fold prior decisions into the learning ledger;
 *   2. ONE LLM call drafts 3 founder-voice posts across distinct angles, steered by
 *      the ledger (rejected angles never return; approved posts aren't repeated);
 *   3. deterministic guardrails — length window, paragraph breaks, hook length, and
 *      the §5a hook-is-first-line convention — violators dropped and logged, never
 *      self-reported by the model;
 *   4. one pending card per post → ONE Slack message with an Approve/Deny pair PER
 *      post (bare card ids — the gateway PATCHes `cards`), confidence rate in the
 *      header. Post-and-finish; Approve records "I'll post this" (operator
 *      copy-pastes to LinkedIn — no OAuth by design, see the spec's trust model).
 */

const POST_COUNT = 3;

const ANGLES =
  "a behind-the-scenes product decision, a lesson learned from building, an industry " +
  "observation or contrarian take, a product milestone and what it actually means, a " +
  "customer story and its outcome";

const POSTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    posts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          angle: { type: "string" },
          hook: { type: "string" },
        },
        required: ["text", "angle", "hook"],
      },
    },
  },
  required: ["posts"],
} as const;

function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

async function runDailyLinkedIn(project: Project): Promise<{ staged: number; skipped?: true }> {
  // 1. One cards read serves idempotency + memory + confidence.
  let rows: LinkedInCardRow[] = [];
  try {
    rows = await listRecentCards(project.projectId, "LinkedIn Post", 60);
  } catch (err) {
    // Graceful degradation: a repeat-ish draft beats no drafts. (If cards reads are
    // down, the insert below will fail loudly anyway — no duplicate risk.)
    logger.warn("LinkedIn memory unavailable — running memory-less", { err: String(err) });
  }
  const today = dayKey();
  if (hasCardForDay(rows, today)) {
    logger.info("LinkedIn drafts already staged today — skipping (idempotent re-run)", {
      projectId: project.projectId,
      day: today,
    });
    return { staged: 0, skipped: true };
  }
  const memory = foldLinkedInMemory(rows);
  const priorBlock = memoryBlock(memory);

  // 2. ONE structured call → 3 founder-voice posts. (The only neural step.)
  const result = await generateStructured<{ posts: LinkedInPost[] }>({
    system:
      brandSystemPreamble(project) +
      "\n\nYou write LinkedIn posts in the founder's first-person voice — a person talking " +
      "honestly about what they are building, what they have learned, and why it matters. " +
      "Not a brand talking at an audience. Be conversational (written as a person), honest " +
      "(specific and grounded, never generic), and credible: no hype, no rocket-ship emojis, " +
      "no empty inspiration, no engagement-bait, no hashtag walls (2–3 hashtags at most). " +
      `Format for LinkedIn: short paragraphs separated by blank lines — no walls of text, no ` +
      `paragraph longer than ${PARAGRAPH_MAX_CHARS} characters. Each post must be between ` +
      `${POST_MIN_CHARS} and ${POST_MAX_CHARS} characters.`,
    prompt:
      (priorBlock ? `PRIOR CONTEXT (honor this):\n${priorBlock}\n\n` : "") +
      `Draft exactly ${POST_COUNT} LinkedIn posts for today, each taking a DIFFERENT angle from: ${ANGLES}.\n` +
      `- hook: the opening line. LinkedIn truncates the post after ~2 lines, so this line ` +
      `alone has to earn the "…more" click. Under ${HOOK_MAX_CHARS} characters.\n` +
      `- text: the COMPLETE post, ready to paste. It MUST begin with the hook line verbatim, ` +
      `then a blank line, then the rest in short paragraphs separated by blank lines (at ` +
      `least ${MIN_PARAGRAPH_BREAKS} blank-line breaks).\n` +
      `- angle: which angle this post takes.\n` +
      `Aim for 150–250 words per post.`,
    schema: POSTS_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 2400,
  });

  const posts = Array.isArray(result?.posts) ? result.posts : [];
  if (!posts.length) throw new Error("LinkedIn draft generation returned no posts");

  // 3. Deterministic guardrails.
  const { kept, dropped } = filterPosts(posts);
  for (const d of dropped) {
    logger.warn("LinkedIn post dropped by guardrails", { angle: d.post.angle, violations: d.violations });
  }
  if (!kept.length) throw new Error("All LinkedIn posts violated guardrails — nothing to stage");

  // 4. Stage cards, then ONE Slack message with a per-post Approve/Deny pair.
  const obs = currentObs();
  const cardIds = await insertCards(
    kept.map((p) => ({
      projectId: project.projectId,
      agent: "linkedin-agent",
      type: "LinkedIn Post" as const,
      status: "pending" as const,
      payload: { text: p.text, angle: p.angle, hook: p.hook, traceId: obs?.traceId },
    })),
  );

  const channel = process.env.SLACK_REVIEW_CHANNEL;
  if (channel) {
    const confLine =
      memory.confidence.rate !== null
        ? `*Confidence:* ${Math.round(memory.confidence.rate * 100)}% accepted over ${memory.confidence.decided} decided drafts`
        : "*Confidence:* no decisions yet — first runs are always fully reviewed";
    const card = perFixReviewCard({
      headerText: `💼 Daily LinkedIn drafts — ${project.name}`,
      introLines: [
        `*Date:* ${today}   ·   ${confLine}`,
        `Draft-only: *Approve = "I'll post this"* (copy-paste to LinkedIn). Decide each post below:`,
      ],
      // The card is what the operator copies out of, so the post has to render whole —
      // the 1200 default would clip a typical 150–250 word post mid-sentence.
      // ponytail: 2600 keeps title + post + meta inside Slack's 3000-char section
      // limit. A post above ~2600 chars still clips; the prompt targets ~1600, so
      // that's the rare tail. If it ever bites, link out to the card instead.
      summaryLimit: 2600,
      fixes: kept.map((p, i) => ({
        title: p.hook,
        summary: p.text,
        metaLine: `Angle: ${p.angle} · ${p.text.length}/${POST_MAX_CHARS} chars`,
        value: cardIds[i] ?? "", // bare card id → gateway PATCHes `cards`; insertCards returns 1 id per card
      })),
    });
    try {
      await postMessage({ channel, text: card.text, blocks: card.blocks });
    } catch (err) {
      logger.warn("LinkedIn Slack card failed to post (cards already staged)", { err: String(err) });
    }
  }

  await auditLog({
    agent: "linkedin-agent",
    projectId: project.projectId,
    action: "daily_linkedin_drafts",
    detail: { staged: kept.length, dropped: dropped.length, day: today },
  });
  return { staged: kept.length };
}

export const dailyLinkedInDrafts = schemaTask({
  id: "daily-linkedin-drafts",
  schema: AgentPayload,
  maxDuration: 300,
  run: async (payload, { ctx }) => {
    const lf = langfuse();
    if (!lf) return runDailyLinkedIn(payload.project); // Langfuse disabled → run untraced
    const trace = lf.trace({
      id: ctx.run.id,
      name: "daily-linkedin-drafts",
      metadata: { projectId: payload.project.projectId, url: payload.project.url },
    });
    try {
      return await runWithObservability(
        { traceId: ctx.run.id, trace, cost: { usd: 0, promptTokens: 0, completionTokens: 0 } },
        () => runDailyLinkedIn(payload.project),
      );
    } finally {
      await flushLangfuse(); // short-lived container — flush before it dies
    }
  },
});

/**
 * Daily schedule (13:15 UTC) — per-project fan-out. Staggered 15 min behind the X
 * agent so the review cards arrive in sequence rather than as one dump.
 */
export const dailyLinkedInDraftsScheduled = schedules.task({
  id: "daily-linkedin-drafts-scheduled",
  cron: "15 13 * * *",
  run: async (_payload, { ctx }) => {
    const projects = await listProjects();
    logger.info("Daily LinkedIn fan-out", { count: projects.length, runId: ctx.run.id });
    for (const project of projects) await dailyLinkedInDrafts.trigger({ project });
    return { dispatched: projects.length };
  },
});
