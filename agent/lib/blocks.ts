import type { CardType } from "../schemas";

/**
 * Slack Block Kit builders. One review card layout serves every Okara card type —
 * a header (agent + card type), the draft/preview body, optional metadata context,
 * and Approve / Reject buttons whose `value` carries the waitpoint token id so the
 * gateway can resume the right run.
 */

// Loose Block Kit type — Slack's SDK accepts plain objects.
export type SlackBlock = Record<string, unknown>;

/** Slack section text has a 3000-char limit; truncate defensively. */
function truncate(s: string, max = 2900): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export interface ReviewCardInput {
  cardType: CardType;
  agent: string;
  /** Headline shown in bold (e.g. tweet preview, article title, thread title). */
  title: string;
  /** The main body the operator reviews (draft text). */
  body: string;
  /** Optional key/value metadata lines (subreddit, severity, keyword, etc.). */
  meta?: Array<{ label: string; value: string }>;
  /** The action that runs on approve, shown on the button (e.g. "Post to X"). */
  approveLabel?: string;
  /** Label for the reject button (defaults to "Reject"). */
  rejectLabel?: string;
  tokenId: string;
}

export function reviewCard(input: ReviewCardInput): { text: string; blocks: SlackBlock[] } {
  const fallback = `${input.cardType} from ${input.agent} — review needed`;

  const metaText =
    input.meta && input.meta.length > 0
      ? input.meta.map((m) => `*${m.label}:* ${m.value}`).join("   ·   ")
      : undefined;

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `🟢 ${input.cardType}`, emoji: true },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `Agent: *${input.agent}*` }],
    },
  ];

  if (input.title) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: truncate(`*${input.title}*`) },
    });
  }

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: truncate(input.body) },
  });

  if (metaText) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: truncate(metaText, 2900) }] });
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        style: "primary",
        text: { type: "plain_text", text: input.approveLabel ?? "Approve", emoji: true },
        action_id: "okara_approve",
        value: input.tokenId,
      },
      {
        type: "button",
        style: "danger",
        text: { type: "plain_text", text: input.rejectLabel ?? "Reject", emoji: true },
        action_id: "okara_reject",
        value: input.tokenId,
      },
    ],
  });

  return { text: fallback, blocks };
}

export interface BatchReviewFix {
  /** Headline, e.g. "[HIGH] Add alt text to all images". */
  title: string;
  /** One- or two-line summary (full detail lives in the report). */
  summary: string;
  /** Optional metadata line (category, etc.). */
  metaLine?: string;
  /** This fix's Supabase card id (collected into the single batch button `value`). */
  value: string;
}

/**
 * ONE message that bundles the report summary + every fix, followed by a SINGLE
 * Approve/Deny pair that decides the whole batch at once. The button `value` is the
 * comma-joined list of every fix's card id, so the gateway records one decision
 * across all cards. Buttons reuse the okara_approve/okara_reject action ids the
 * gateway already handles.
 */
export function batchReviewCard(input: {
  headerText: string;
  /** Intro mrkdwn lines (score, date, report link, instructions). */
  introLines: string[];
  fixes: BatchReviewFix[];
  approveLabel?: string;
  rejectLabel?: string;
}): { text: string; blocks: SlackBlock[] } {
  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: truncate(input.headerText, 150), emoji: true } },
  ];
  if (input.introLines.length) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: truncate(input.introLines.join("\n")) } });
  }
  blocks.push({ type: "divider" });

  for (const f of input.fixes) {
    const body = `*${truncate(f.title, 280)}*\n${truncate(f.summary, 1200)}${f.metaLine ? `\n_${truncate(f.metaLine, 300)}_` : ""}`;
    blocks.push({ type: "section", text: { type: "mrkdwn", text: truncate(body) } });
  }
  blocks.push({ type: "divider" });

  // One decision for the whole batch. value = every card id, comma-joined.
  // ponytail: comma-joined ids cap out well under Slack's 2000-char button value
  // (WEEKLY_FIX_LIMIT=5 × ~37-char UUID ≈ 185 chars). Switch to a single batch id if
  // the fix count ever grows past ~50.
  const allIds = input.fixes.map((f) => f.value).join(",");
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        style: "primary",
        text: { type: "plain_text", text: input.approveLabel ?? "Approve all", emoji: true },
        action_id: "okara_approve",
        value: allIds,
      },
      {
        type: "button",
        style: "danger",
        text: { type: "plain_text", text: input.rejectLabel ?? "Deny all", emoji: true },
        action_id: "okara_reject",
        value: allIds,
      },
    ],
  });

  return { text: `${input.headerText} — ${input.fixes.length} fixes to review`, blocks };
}

/** Terminal-state card (replaces the review card after a decision). */
export function decidedCard(input: {
  cardType: CardType;
  title: string;
  decision: "approved" | "rejected" | "skipped";
}): { text: string; blocks: SlackBlock[] } {
  const emoji = input.decision === "approved" ? "✅" : input.decision === "rejected" ? "🚫" : "⏭️";
  const label =
    input.decision === "approved" ? "Approved" : input.decision === "rejected" ? "Rejected" : "Skipped (timed out)";
  return {
    text: `${input.cardType} — ${label}`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `${emoji} *${input.cardType} — ${label}*\n${truncate(input.title, 500)}` },
      },
    ],
  };
}

export interface PerFixReviewItem {
  title: string;
  summary: string;
  metaLine?: string;
  /** Gateway token for THIS fix alone (e.g. "geo_fixes:42"). */
  value: string;
}

/**
 * ONE message with an Approve/Deny pair PER fix — each decision lands on its own row
 * (unlike batchReviewCard's all-or-nothing pair). Buttons reuse the exact
 * okara_approve / okara_reject action ids the gateway matches on; Slack only requires
 * action_id uniqueness WITHIN a block, and each pair lives in its own actions block,
 * so reusing the ids across blocks is valid and needs zero gateway changes.
 */
export function perFixReviewCard(input: {
  headerText: string;
  introLines: string[];
  fixes: PerFixReviewItem[];
  /**
   * Per-item summary budget. Defaults to 1200 — plenty for a fix description or a
   * tweet. Raise it when the summary IS the deliverable the operator copies out of
   * the card (LinkedIn posts run 900–1600 chars), so review doesn't hand them a
   * silently clipped draft. Ceiling is Slack's own 3000-char section limit, which
   * `truncate(body)` still enforces over title + summary + metaLine combined.
   */
  summaryLimit?: number;
}): { text: string; blocks: SlackBlock[] } {
  const summaryLimit = input.summaryLimit ?? 1200;
  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: truncate(input.headerText, 150), emoji: true } },
  ];
  if (input.introLines.length) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: truncate(input.introLines.join("\n")) } });
  }
  for (const f of input.fixes) {
    blocks.push({ type: "divider" });
    const body = `*${truncate(f.title, 280)}*\n${truncate(f.summary, summaryLimit)}${f.metaLine ? `\n_${truncate(f.metaLine, 300)}_` : ""}`;
    blocks.push({ type: "section", text: { type: "mrkdwn", text: truncate(body) } });
    blocks.push({
      type: "actions",
      elements: [
        { type: "button", style: "primary", text: { type: "plain_text", text: "Approve", emoji: true }, action_id: "okara_approve", value: f.value },
        { type: "button", style: "danger", text: { type: "plain_text", text: "Deny", emoji: true }, action_id: "okara_reject", value: f.value },
      ],
    });
  }
  return { text: `${input.headerText} — ${input.fixes.length} fixes to review`, blocks };
}
