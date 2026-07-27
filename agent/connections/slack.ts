import { createHmac, timingSafeEqual } from "node:crypto";
import { WebClient } from "@slack/web-api";
import type { SlackBlock } from "../lib/blocks";

/**
 * Slack — REAL integration. Posts the review card, updates it to terminal states,
 * posts ad-hoc messages, and verifies inbound request signatures. Used by the HITL
 * gate (lib/hitl-slack.ts) and the gateway (server/gateway.ts).
 *
 * Adapted from linkedin-outreach-triggerdev/src/integrations/slack.ts.
 */

let _client: WebClient | null = null;

function client(): WebClient {
  if (_client) return _client;
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN must be set");
  _client = new WebClient(token);
  return _client;
}

export interface PostedMessage {
  ts: string;
  channel: string;
}

/** Open a Slack modal (views.open) — used to capture the deny reason on a Deny tap. */
export async function openModal(input: { triggerId: string; view: Record<string, unknown> }): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await client().views.open({ trigger_id: input.triggerId, view: input.view as any });
}

/** Post a Block Kit message (the review card). Returns the message ts + channel. */
export async function postMessage(input: {
  channel: string;
  text: string;
  blocks?: SlackBlock[];
}): Promise<PostedMessage> {
  const res = await client().chat.postMessage({
    channel: input.channel,
    text: input.text,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    blocks: input.blocks as any,
  });
  return { ts: String(res.ts ?? ""), channel: String(res.channel ?? input.channel) };
}

/** Replace an existing message in place (e.g. review card → "Posted ✅"). */
export async function updateMessage(input: {
  channel: string;
  ts: string;
  text: string;
  blocks?: SlackBlock[];
}): Promise<void> {
  await client().chat.update({
    channel: input.channel,
    ts: input.ts,
    text: input.text,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    blocks: input.blocks as any,
  });
}

/**
 * Reply to an interaction via its response_url (works ~30 min, no scopes needed).
 */
export async function respondViaResponseUrl(
  responseUrl: string,
  body: {
    text?: string;
    blocks?: SlackBlock[];
    response_type?: "ephemeral" | "in_channel";
    replace_original?: boolean;
  },
): Promise<void> {
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Verify a Slack request signature (v0 scheme). Reject if the signing secret/header
 * is missing, the timestamp is stale (> 5 min — replay protection), or the HMAC
 * doesn't match in constant time.
 *
 * basestring = `v0:{timestamp}:{rawBody}`; expected = `v0=` + hex(HMAC-SHA256).
 */
export function verifySlackSignature(input: {
  signingSecret: string;
  signature: string | undefined | null;
  timestamp: string | undefined | null;
  rawBody: string;
}): boolean {
  const { signingSecret, signature, timestamp, rawBody } = input;
  if (!signingSecret || !signature || !timestamp) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false; // stale → likely replay

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = "v0=" + createHmac("sha256", signingSecret).update(base, "utf8").digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
