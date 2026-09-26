// Keeps Workers AI use inside a daily allowance. Every Cloudflare account gets
// 10,000 neurons a day free, shared by all its Workers; sniff keeps to
// SNIFF_AI_DAILY_NEURONS (5,000 by default) so other Workers keep some too.
// Spending is counted per UTC day from the token counts Workers AI returns.
import { getValue, setValue } from "./settings";

/** Neurons per token for @cf/meta/llama-3.3-70b-instruct-fp8-fast ($0.293 / $2.253 per million tokens). */
const NEURONS_PER_INPUT_TOKEN = 26_668 / 1e6;
const NEURONS_PER_OUTPUT_TOKEN = 204_805 / 1e6;
export const DEFAULT_DAILY_NEURONS = 5_000;

export type Usage = { prompt_tokens?: number; completion_tokens?: number };

export class AiBudgetSpent extends Error {
  constructor(spent: number, limit: number) {
    super(`Today's AI allowance is used up (${Math.round(spent)} of ${limit} neurons); it resets at 00:00 UTC.`);
  }
}

export function neurons(usage: Usage | undefined, promptChars: number, answerChars: number): number {
  // Without a usage report, estimate about four characters a token.
  return (usage?.prompt_tokens ?? promptChars / 4) * NEURONS_PER_INPUT_TOKEN + (usage?.completion_tokens ?? answerChars / 4) * NEURONS_PER_OUTPUT_TOKEN;
}

export function dailyLimit(value: string | undefined): number {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_NEURONS;
}

const key = (now: number) => `ai_neurons_${new Date(now).toISOString().slice(0, 10)}`;

export async function spentToday(db: D1Database, now = Date.now()): Promise<number> {
  return Number(await getValue<number>(db, key(now))) || 0;
}

export async function budgetStatus(db: D1Database, limit: number, now = Date.now()) {
  const spent = await spentToday(db, now);
  return { spent: Math.round(spent), limit, left: Math.max(0, Math.round(limit - spent)) };
}

export async function checkBudget(db: D1Database, limit: number, now = Date.now()): Promise<void> {
  const spent = await spentToday(db, now);
  if (spent >= limit) throw new AiBudgetSpent(spent, limit);
}

export async function recordSpend(db: D1Database, amount: number, now = Date.now()): Promise<void> {
  if (!(amount > 0)) return;
  await setValue(db, key(now), (await spentToday(db, now)) + amount);
  await db.prepare(`DELETE FROM settings WHERE key LIKE 'ai_neurons_%' AND key < ?1`).bind(key(now - 7 * 86_400_000)).run();
}
