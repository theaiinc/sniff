// What the model is asked: how welcome a reply would be, and a draft of one.
// Everything product-specific comes from the profile in Settings.
import type { Profile } from "./settings";
import { escapeRegExp } from "./text";

export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const INTENTS = ["asking_for_tool", "problem", "discussion", "job", "promotion", "other"] as const;
export type Reading = { relevance: number; intent: string; summary: string; painPoints: string[] };

export const READING_SCHEMA = {
  type: "object",
  properties: {
    relevance: { type: "integer" },
    intent: { type: "string", enum: INTENTS },
    summary: { type: "string" },
    pain_points: { type: "array", items: { type: "string" } },
  },
  required: ["relevance", "intent", "summary", "pain_points"],
};

export function about(p: Profile): string {
  return `${p.name}${p.url ? ` (${p.url.replace(/^https?:\/\//, "")})` : ""}: ${p.description}`;
}

export function ratingPrompt(p: Profile): string {
  const problems = p.problems.trim() || `problems in ${p.domain}`;
  return (
    `You rate social posts for the team behind a product. ${about(p)}\n` +
    `Score "relevance" 0-100 as how likely a reply from the ${p.name} team would be welcome and genuinely useful to this person right now:\n` +
    `90-100: they ask which tool or service to use for ${p.domain}, or how to get started with it.\n` +
    `70-89: they describe a concrete problem ${p.name} addresses (${problems}).\n` +
    `40-69: a ${p.domain} discussion where an experienced practitioner's reply would add value, but a product mention would be out of place.\n` +
    `10-39: ${p.domain} is mentioned in passing, or a comment deep in a thread about something else.\n` +
    `0-9: unrelated (another meaning of the words), job ads, self-promotion, news.\n` +
    `Reply with JSON: {"relevance", "intent": one of ${INTENTS.join("|")}, "summary": one sentence on what they want, "pain_points": up to 3 short phrases naming problems they describe (empty list if none)}`
  );
}

export function draftPrompt(p: Profile, community: string, guidance: string, instruction?: string): string {
  const link = p.url ? `No links except ${p.url.replace(/^https?:\/\//, "")}` : "No links";
  let prompt =
    `You draft a reply a member of the ${p.name} team will review and post themselves. ${about(p)}\n` +
    `Rules: lead with concrete, specific advice that answers them and helps even if they never use ${p.name}. ` +
    `Only if they are looking for a tool, or ${p.name} directly solves their problem, add one sentence at the end naming ${p.name} and saying what it would do for them, written as "(I work on ${p.name}.)". ` +
    `Otherwise don't mention ${p.name} at all. ${link}, no hype, no emojis, no sign-off. Match the tone of ${community}. Under 120 words. Output only the reply text.`;
  if (guidance.trim()) prompt += `\nThe team's guidance for every reply (follow it unless it breaks the rules above):\n${guidance.trim().slice(0, 2000)}`;
  if (instruction?.trim()) prompt += `\nFor this reply specifically: ${instruction.trim().slice(0, 1000)}`;
  return prompt;
}

export function summaryPrompt(p: Profile, days: number): string {
  return (
    `You are a market analyst for a startup. ${about(p)} From the posts below (people discussing ${p.domain} online in the last ${days} days), ` +
    `write a short brief: the 3-5 strongest needs or pain points with rough frequency, what tools people mention and complain about, ` +
    `and 2-3 concrete opportunities for ${p.name} (product, content or where to show up). Plain text with short headings and bullets. ` +
    `Under 250 words. Don't invent numbers beyond the posts given.`
  );
}

/** The disclosure belongs only to a reply that actually mentions the product. */
export function tidyDraft(text: string, productName: string): string {
  let t = text.trim().replace(/^["']|["']$/g, "");
  if (productName.trim()) {
    const name = escapeRegExp(productName.trim());
    const disclosure = new RegExp(`\\s*\\(?I work on ${name}\\.?\\)?\\.?\\s*$`, "i");
    if (disclosure.test(t) && !new RegExp(name, "i").test(t.replace(disclosure, ""))) t = t.replace(disclosure, "");
  }
  return t.trim().slice(0, 1500);
}

/** The fields, read loosely from JSON the model got slightly wrong (pain_points not in a list, unquoted text). */
function looseReading(text: string): Partial<{ relevance: number; intent: string; summary: string; pain_points: string[] }> | null {
  const relevance = text.match(/"relevance"\s*:\s*(\d+)/)?.[1];
  if (!relevance) return null;
  const summary = text.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1] ?? text.match(/"summary"\s*:\s*([^,"}][^,}]*)/)?.[1];
  const painPart = text.match(/"pain_points"\s*:\s*([\s\S]*?)(?:\}\s*$|$)/)?.[1] ?? "";
  return {
    relevance: Number(relevance),
    intent: text.match(/"intent"\s*:\s*"([a-z_]+)"/)?.[1],
    summary: summary?.trim(),
    pain_points: [...painPart.matchAll(/"((?:[^"\\]|\\.)+)"/g)].map((m) => m[1]!),
  };
}

export function parseReading(text: string): Reading | null {
  const json = text.match(/\{[\s\S]*\}?/)?.[0];
  if (!json) return null;
  try {
    let r: Partial<{ relevance: number; intent: string; summary: string; pain_points: string[] | string }> | null;
    try {
      r = JSON.parse(json);
    } catch {
      r = looseReading(json);
    }
    if (!r) return null;
    if (typeof r.pain_points === "string") r.pain_points = r.pain_points ? [r.pain_points] : [];
    const relevance = Math.max(0, Math.min(100, Math.round(Number(r.relevance))));
    if (!Number.isFinite(relevance)) return null;
    return {
      relevance,
      intent: (INTENTS as readonly string[]).includes(String(r.intent)) ? String(r.intent) : "other",
      summary: String(r.summary ?? "").slice(0, 300),
      painPoints: Array.isArray(r.pain_points) ? r.pain_points.map((p) => String(p).slice(0, 80)).slice(0, 5) : [],
    };
  } catch {
    return null;
  }
}
