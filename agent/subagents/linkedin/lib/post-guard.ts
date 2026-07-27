import { checkContent } from "../../../lib/guardrails";

/**
 * LinkedIn post guardrails (Gate 3: the LLM never self-reports compliance — code
 * measures). Okara claims posts are "formatted for LinkedIn's style with short
 * paragraphs and line breaks"; here that claim is enforced, not prompted. Any
 * violation drops the whole post; surviving posts pass through untouched.
 *
 * Also enforces the spec's §5a schema convention — `text` is the complete
 * paste-ready post and BEGINS with `hook`, which is a duplicated display field.
 * Pinning it here is what keeps the renderer, recall, and the operator's
 * copy-paste from each resolving the ambiguity differently.
 */

export interface LinkedInPost {
  /** The complete paste-ready post; begins with `hook` as its first line. */
  text: string;
  angle: string;
  /** The opening line, duplicated for display (Slack title, the "…more" fold). */
  hook: string;
}

export const POST_MIN_CHARS = 400; // below this there's no substance to review
export const POST_MAX_CHARS = 3000; // LinkedIn's own limit
export const HOOK_MAX_CHARS = 200; // roughly the ~2 lines shown before "…more"
export const PARAGRAPH_MAX_CHARS = 350; // anything longer reads as a wall of text
export const MIN_PARAGRAPH_BREAKS = 2; // i.e. 3+ paragraphs

/** Split on blank lines — the breaks that actually render as paragraphs on LinkedIn. */
function paragraphsOf(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function filterPosts(posts: LinkedInPost[]): {
  kept: LinkedInPost[];
  dropped: Array<{ post: LinkedInPost; violations: string[] }>;
} {
  const kept: LinkedInPost[] = [];
  const dropped: Array<{ post: LinkedInPost; violations: string[] }> = [];

  for (const post of posts) {
    const violations: string[] = [];
    const text = post.text ?? "";
    const hook = post.hook ?? "";

    if (!text.trim()) {
      violations.push("empty post (no text)");
    } else {
      // Brand rules + the hard LinkedIn ceiling.
      const check = checkContent(text, { maxChars: POST_MAX_CHARS });
      if (!check.ok) violations.push(...check.violations);

      if (text.length < POST_MIN_CHARS) {
        violations.push(`Too short: ${text.length} chars (min ${POST_MIN_CHARS})`);
      }

      const paragraphs = paragraphsOf(text);
      const breaks = paragraphs.length - 1;
      if (breaks < MIN_PARAGRAPH_BREAKS) {
        violations.push(`Wall of text: ${breaks} paragraph break(s) (min ${MIN_PARAGRAPH_BREAKS})`);
      }
      paragraphs.forEach((p, i) => {
        if (p.length > PARAGRAPH_MAX_CHARS) {
          violations.push(`Paragraph ${i + 1} too long: ${p.length} chars (max ${PARAGRAPH_MAX_CHARS})`);
        }
      });
    }

    if (!hook.trim()) {
      violations.push("empty hook");
    } else {
      if (hook.length > HOOK_MAX_CHARS) {
        violations.push(`Hook too long: ${hook.length} chars (max ${HOOK_MAX_CHARS}) — it would be cut at the "…more" fold`);
      }
      // §5a: hook is the first line OF text, not a separate sentence. Compared on
      // trimmed edges so a stray leading newline isn't a "violation" worth a redraft.
      if (text.trim() && !text.trimStart().startsWith(hook.trim())) {
        violations.push("Hook is not the first line of text (§5a convention)");
      }
    }

    if (violations.length) dropped.push({ post, violations });
    else kept.push(post);
  }

  return { kept, dropped };
}
