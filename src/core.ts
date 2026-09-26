// sniff's engine: search the sources for the enabled topics, keep what really
// matches, rate new posts with Workers AI, draft replies for the good ones,
// and send an hourly digest of hot posts to a webhook. Nothing is ever posted
// anywhere: people read the drafts and reply themselves.
import { AiBudgetSpent, budgetStatus, checkBudget, dailyLimit, neurons, recordSpend, type Usage } from "./budget";
import { draftPrompt, MODEL, parseReading, ratingPrompt, READING_SCHEMA, summaryPrompt, tidyDraft, type Reading } from "./reading";
import { getSettings, getValue, profileReady, setValue, SOURCES, type Settings, type Source } from "./settings";
import { hn, reddit, stackexchange, type Found, type Topic } from "./sources";
import { mentions } from "./text";

export * from "./settings";
export * from "./sources";
export * from "./reading";
export * from "./budget";
export { mentions, terms, plainText } from "./text";

export interface SniffEnv {
  SNIFF_DB: D1Database;
  AI?: Ai;
  /** Optional: raises Stack Exchange's quota from 300 to 10,000 requests a day, and allows more than two feeds. */
  STACKEXCHANGE_KEY?: string;
  /** Optional: Slack- or Discord-compatible incoming webhook for the hourly digest of hot posts. */
  SNIFF_WEBHOOK_URL?: string;
  /** This deployment's own address, for links in the digest. */
  SNIFF_PUBLIC_URL?: string;
  /** Daily Workers AI allowance in neurons (default 5,000 of the account's free 10,000). */
  SNIFF_AI_DAILY_NEURONS?: string;
}

type Row = Record<string, unknown>;

const DAY = 86_400_000;
/** How often each source is searched (Stack Exchange's shared quota is small). */
export const INTERVAL_MS: Record<Source, number> = { reddit: 15 * 60_000, hn: 15 * 60_000, stackexchange: 2 * 3600_000 };
const MAX_AI_PER_RUN = 15;
/** How long found posts are kept, unless replied to. */
export const RETENTION_DAYS = 180;
export const DIGEST_EVERY_MS = 60 * 60_000;

// ── Topics ──

export async function listTopics(db: D1Database, all = false): Promise<Topic[]> {
  const { results } = await db.prepare(`SELECT id, name, query, sources FROM topics ${all ? "" : "WHERE enabled = 1"} ORDER BY created_at`).all<Row>();
  return results.map((t) => ({
    id: String(t.id),
    name: String(t.name),
    query: String(t.query),
    sources: String(t.sources).split(",").filter((s): s is Source => SOURCES.includes(s as Source)),
  }));
}

/** The topic a post belongs to: the first whose terms it mentions. */
export function topicFor(list: Topic[], p: Found): Topic | null {
  return list.find((t) => mentions(t.query, `${p.title ?? ""}\n${p.body ?? ""}`)) ?? null;
}

async function store(db: D1Database, topicId: string | null, posts: Found[]): Promise<number> {
  let added = 0;
  for (const p of posts) {
    const r = await db.prepare(
      `INSERT INTO posts (id, source, external_id, topic_id, url, title, body, author, community, posted_at, score, comments)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
       ON CONFLICT (source, external_id) DO NOTHING`,
    ).bind(crypto.randomUUID(), p.source, p.externalId, topicId, p.url, p.title, p.body, p.author, p.community, p.postedAt, p.score, p.comments).run();
    if (r.meta.changes) added++;
  }
  return added;
}

async function fetchSource(env: SniffEnv, settings: Settings, source: Source, list: Topic[], since: number): Promise<Found[]> {
  if (source === "reddit") return reddit(list, settings.communities.subreddits);
  // Stack Exchange is quiet: always look back a week; duplicates are skipped.
  if (source === "stackexchange") return stackexchange(settings.communities.stackexchange, Math.min(since, Date.now() - 7 * DAY), env.STACKEXCHANGE_KEY);
  return hn(list, since);
}

function wanted(settings: Settings, source: Source, list: Topic[]): boolean {
  if (source === "reddit") return list.length > 0 || settings.communities.subreddits.length > 0;
  if (source === "stackexchange") return settings.communities.stackexchange.length > 0;
  return list.length > 0;
}

// ── Running ──

/** Searches every due source, stores new matches, rates them and sends the digest. `force` ignores the intervals. */
export async function run(env: SniffEnv, now = Date.now(), force = false) {
  const db = env.SNIFF_DB;
  const settings = await getSettings(db);
  const all = await listTopics(db);
  const errors: string[] = [];
  let found = 0;
  for (const source of SOURCES) {
    const list = all.filter((t) => t.sources.includes(source));
    if (!wanted(settings, source, list)) continue;
    const last = Number(await getValue<number>(db, `last_${source}`)) || 0;
    // A minute of slack: cron runs start a few seconds apart.
    if (!force && now - last < INTERVAL_MS[source] - 60_000) continue;
    // The first run looks back two days; later runs overlap the last one a little.
    const since = last ? last - 30 * 60_000 : now - 2 * DAY;
    try {
      const posts = await fetchSource(env, settings, source, list, since);
      const byTopic = new Map<string | null, Found[]>();
      for (const p of posts) {
        if (Date.parse(p.postedAt) < now - 7 * DAY) continue;
        const topic = topicFor(list, p);
        if (!topic && !p.fromCommunity) continue; // the search matched loosely
        const k = topic?.id ?? null;
        byTopic.set(k, [...(byTopic.get(k) ?? []), p]);
      }
      let added = 0;
      for (const [topicId, group] of byTopic) added += await store(db, topicId, group);
      found += added;
      console.log(`sniff ${source}: ${posts.length} fetched, ${[...byTopic.values()].flat().length} kept, ${added} new`);
      await setValue(db, `last_${source}`, now);
    } catch (e) {
      // Tried again next run rather than waiting out the interval.
      errors.push(`${source}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const rated = await rate(env, settings);
  await db.prepare(`DELETE FROM posts WHERE posted_at < ?1 AND status != 'replied'`).bind(new Date(now - RETENTION_DAYS * DAY).toISOString()).run();
  const digest = await sendDigest(env, settings, now).catch((e) => `failed: ${String(e)}`);
  return { found, rated, errors, digest };
}

// ── AI ──

async function ask(env: SniffEnv, system: string, user: string, maxTokens: number, schema?: object): Promise<string> {
  if (!env.AI) throw new Error("Workers AI isn't bound (add \"ai\": { \"binding\": \"AI\" } to wrangler.jsonc)");
  const limit = dailyLimit(env.SNIFF_AI_DAILY_NEURONS);
  await checkBudget(env.SNIFF_DB, limit);
  const input: Record<string, unknown> = { messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: maxTokens };
  if (schema) input.response_format = { type: "json_schema", json_schema: schema };
  const out = (await env.AI.run(MODEL as never, input as never)) as { response?: unknown; usage?: Usage };
  // JSON answers can come back already parsed.
  const text = typeof out.response === "string" ? out.response : out.response == null ? "" : JSON.stringify(out.response);
  await recordSpend(env.SNIFF_DB, neurons(out.usage, system.length + user.length, text.length));
  return text;
}

async function read(env: SniffEnv, settings: Settings, p: Row): Promise<Reading | null> {
  const text = await ask(
    env,
    ratingPrompt(settings.profile),
    `Where: ${p.community ?? p.source}\nTitle: ${p.title ?? ""}\n\n${String(p.body ?? "").slice(0, 1500)}`,
    300,
    READING_SCHEMA,
  );
  const reading = parseReading(text);
  if (!reading) console.warn("sniff: unreadable rating:", text.slice(0, 300));
  return reading;
}

async function draftReply(env: SniffEnv, settings: Settings, p: Row, summary: string, instruction?: string): Promise<string> {
  return tidyDraft(await ask(
    env,
    draftPrompt(settings.profile, String(p.community ?? "the forum"), settings.replyGuidance, instruction),
    `They want: ${summary}\nTitle: ${p.title ?? ""}\n\n${String(p.body ?? "").slice(0, 1500)}`,
    350,
  ), settings.profile.name);
}

/** AI-reads the newest unrated posts; drafts replies for ones worth answering. Needs a profile. */
export async function rate(env: SniffEnv, settings?: Settings, limit = MAX_AI_PER_RUN): Promise<number> {
  const s = settings ?? (await getSettings(env.SNIFF_DB));
  if (!env.AI || !profileReady(s.profile)) return 0;
  const { results } = await env.SNIFF_DB.prepare(`SELECT * FROM posts WHERE relevance IS NULL ORDER BY posted_at DESC LIMIT ?1`).bind(limit).all<Row>();
  let done = 0;
  for (const p of results) {
    try {
      const reading = await read(env, s, p);
      if (!reading) {
        await env.SNIFF_DB.prepare(`UPDATE posts SET relevance = 0, intent = 'other' WHERE id = ?1`).bind(p.id).run();
        continue;
      }
      const draft = reading.relevance >= 50 && ["asking_for_tool", "problem", "discussion"].includes(reading.intent)
        ? await draftReply(env, s, p, reading.summary)
        : null;
      await env.SNIFF_DB.prepare(
        `UPDATE posts SET relevance = ?2, intent = ?3, summary = ?4, pain_points = ?5, reply_draft = ?6 WHERE id = ?1`,
      ).bind(p.id, reading.relevance, reading.intent, reading.summary, JSON.stringify(reading.painPoints), draft).run();
      done++;
    } catch (e) {
      if (e instanceof AiBudgetSpent) console.log("sniff:", e.message);
      else console.error("sniff rate:", String(e));
      break; // out of allowance, or the model is failing; try again next run
    }
  }
  return done;
}

/** A new draft for one post, following an optional one-off instruction. */
export async function redraft(env: SniffEnv, id: string, instruction?: string): Promise<string> {
  const settings = await getSettings(env.SNIFF_DB);
  if (!profileReady(settings.profile)) throw new Error("Fill in your product profile first");
  const p = await env.SNIFF_DB.prepare(`SELECT * FROM posts WHERE id = ?1`).bind(id).first<Row>();
  if (!p) throw new Error("Post not found");
  const draft = await draftReply(env, settings, p, String(p.summary ?? p.title ?? ""), instruction);
  await env.SNIFF_DB.prepare(`UPDATE posts SET reply_draft = ?2 WHERE id = ?1`).bind(id, draft).run();
  return draft;
}

export async function aiStatus(env: SniffEnv) {
  return { bound: Boolean(env.AI), ...(await budgetStatus(env.SNIFF_DB, dailyLimit(env.SNIFF_AI_DAILY_NEURONS))) };
}

// ── Digest (webhook) ──

export function digestText(posts: Row[], publicUrl?: string): string {
  const line = (p: Row) => `• ${p.community ?? p.source}: ${String(p.title ?? "(untitled)").slice(0, 120)} (fit ${p.relevance}) ${p.url}`;
  const head = posts.length === 1 ? "1 post worth answering" : `${posts.length} posts worth answering`;
  const more = posts.length > 8 ? `\n…and ${posts.length - 8} more` : "";
  const open = publicUrl ? `\nDrafts: ${publicUrl.replace(/\/$/, "")}/` : "";
  return `${head}\n${posts.slice(0, 8).map(line).join("\n")}${more}${open}`;
}

/** At most one message an hour, covering hot posts found since the last one. */
export async function sendDigest(env: SniffEnv, settings: Settings, now = Date.now()): Promise<string> {
  if (!env.SNIFF_WEBHOOK_URL) return "no webhook";
  const last = await getValue<string>(env.SNIFF_DB, "digest_at");
  if (last && now - Date.parse(last) < DIGEST_EVERY_MS) return "not due";
  const since = last ?? new Date(now - DAY).toISOString();
  const { results } = await env.SNIFF_DB.prepare(
    `SELECT source, community, title, url, relevance FROM posts
      WHERE relevance >= ?1 AND status = 'new' AND julianday(fetched_at) > julianday(?2)
      ORDER BY relevance DESC LIMIT 50`,
  ).bind(settings.hotRelevance, since).all<Row>();
  if (!results.length) return "nothing new";
  const text = digestText(results, env.SNIFF_PUBLIC_URL);
  // "text" for Slack, "content" for Discord; each ignores the other.
  const res = await fetch(env.SNIFF_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, content: text.slice(0, 1990) }) });
  if (!res.ok) throw new Error(`webhook ${res.status}`);
  await setValue(env.SNIFF_DB, "digest_at", new Date(now).toISOString());
  return `sent ${results.length}`;
}

// ── Market view ──

export async function insights(db: D1Database, days: number, hot = 70, now = Date.now()) {
  const since = new Date(now - days * DAY).toISOString();
  const [byWeek, byCommunity, byIntent, pains, totals] = await Promise.all([
    db.prepare(
      `SELECT strftime('%Y-%m-%d', posted_at, 'weekday 1', '-7 days') AS week, t.name AS topic, count(*) AS n
         FROM posts p LEFT JOIN topics t ON t.id = p.topic_id
        WHERE posted_at >= ?1 GROUP BY week, topic ORDER BY week`,
    ).bind(since).all<Row>(),
    db.prepare(
      `SELECT community, count(*) AS n, round(avg(relevance)) AS relevance FROM posts WHERE posted_at >= ?1 AND community IS NOT NULL
        GROUP BY community ORDER BY n DESC LIMIT 12`,
    ).bind(since).all<Row>(),
    db.prepare(`SELECT intent, count(*) AS n FROM posts WHERE posted_at >= ?1 AND intent IS NOT NULL GROUP BY intent ORDER BY n DESC`).bind(since).all<Row>(),
    db.prepare(`SELECT pain_points FROM posts WHERE posted_at >= ?1 AND relevance >= 40 AND pain_points IS NOT NULL`).bind(since).all<Row>(),
    db.prepare(`SELECT count(*) AS posts, sum(relevance >= ?2) AS hot, sum(status = 'replied') AS replied FROM posts WHERE posted_at >= ?1`).bind(since, hot).all<Row>(),
  ]);
  const painCounts = new Map<string, number>();
  for (const r of pains.results) {
    try {
      for (const p of JSON.parse(String(r.pain_points)) as string[]) {
        const k = p.trim().toLowerCase();
        if (k) painCounts.set(k, (painCounts.get(k) ?? 0) + 1);
      }
    } catch { /* skip */ }
  }
  const weeks = new Map<string, Record<string, number | string>>();
  for (const r of byWeek.results) {
    const w = weeks.get(String(r.week)) ?? { week: String(r.week) };
    w[String(r.topic ?? "Other")] = Number(r.n);
    weeks.set(String(r.week), w);
  }
  const t = totals.results[0] ?? {};
  return {
    days,
    totals: { posts: Number(t.posts) || 0, hot: Number(t.hot) || 0, replied: Number(t.replied) || 0 },
    weekly: [...weeks.values()],
    communities: byCommunity.results.map((r) => ({ community: String(r.community), posts: Number(r.n), relevance: Number(r.relevance) || 0 })),
    intents: byIntent.results.map((r) => ({ intent: String(r.intent), posts: Number(r.n) })),
    painPoints: [...painCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([point, n]) => ({ point, posts: n })),
  };
}

/** A written read of what people are asking for, from the last `days` of relevant posts. */
export async function marketSummary(env: SniffEnv, days: number, now = Date.now()): Promise<string> {
  const settings = await getSettings(env.SNIFF_DB);
  if (!profileReady(settings.profile)) throw new Error("Fill in your product profile first");
  const since = new Date(now - days * DAY).toISOString();
  const { results } = await env.SNIFF_DB.prepare(
    `SELECT community, summary, pain_points FROM posts WHERE posted_at >= ?1 AND relevance >= 40 AND summary IS NOT NULL ORDER BY relevance DESC LIMIT 60`,
  ).bind(since).all<Row>();
  if (!results.length) return "Not enough relevant posts yet.";
  const pains = (r: Row) => { try { return (JSON.parse(String(r.pain_points)) as string[]).join("; "); } catch { return ""; } };
  const lines = results.map((r) => `- (${r.community}) ${r.summary} [${pains(r)}]`).join("\n");
  return (await ask(env, summaryPrompt(settings.profile, days), lines.slice(0, 12000), 700)).trim();
}
