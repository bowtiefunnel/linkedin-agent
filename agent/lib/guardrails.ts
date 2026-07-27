/**
 * Deterministic brand/voice guardrails (no LLM). Agents run generated text through
 * `checkContent()` before staging a card, so obvious problems (banned terms, wrong
 * brand name casing, over-length) are caught without a human round-trip.
 *
 * Rules come from BRAND_RULES_JSON (full override) or are derived from BRAND_NAME.
 */

export interface BrandRules {
  brandName: string;
  brandNameVariants: string[];
  bannedTerms: string[];
  /** 0 = no limit. */
  maxChars: number;
}

let _rules: BrandRules | null = null;

export function brandRules(): BrandRules {
  if (_rules) return _rules;
  const raw = process.env.BRAND_RULES_JSON;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<BrandRules>;
      _rules = {
        brandName: parsed.brandName ?? process.env.BRAND_NAME ?? "",
        brandNameVariants: parsed.brandNameVariants ?? [],
        bannedTerms: parsed.bannedTerms ?? [],
        maxChars: parsed.maxChars ?? 0,
      };
      return _rules;
    } catch {
      // fall through to defaults
    }
  }
  _rules = {
    brandName: process.env.BRAND_NAME ?? "",
    brandNameVariants: [],
    bannedTerms: [],
    maxChars: 0,
  };
  return _rules;
}

export interface GuardrailResult {
  ok: boolean;
  violations: string[];
}

/**
 * Check a piece of generated content. `maxChars` override lets a caller enforce a
 * channel limit (e.g. 280 for a tweet) on top of the brand default.
 */
export function checkContent(text: string, opts: { maxChars?: number } = {}): GuardrailResult {
  const rules = brandRules();
  const violations: string[] = [];
  const lower = text.toLowerCase();

  for (const term of rules.bannedTerms) {
    if (term && lower.includes(term.toLowerCase())) {
      violations.push(`Contains banned term: "${term}"`);
    }
  }

  // Brand name should appear with correct casing when a variant (wrong casing) is used.
  if (rules.brandName) {
    for (const variant of rules.brandNameVariants) {
      if (variant && lower.includes(variant.toLowerCase()) && !text.includes(rules.brandName)) {
        violations.push(`Brand name mis-cased — found "${variant}", expected "${rules.brandName}"`);
      }
    }
  }

  const limit = opts.maxChars ?? rules.maxChars;
  if (limit > 0 && text.length > limit) {
    violations.push(`Too long: ${text.length} chars (max ${limit})`);
  }

  return { ok: violations.length === 0, violations };
}
