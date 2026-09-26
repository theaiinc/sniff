// The JSON API behind the web page. Every route needs the admin token.
import { aiStatus, insights, listTopics, marketSummary, redraft, run, type SniffEnv } from "./core";
import { AiBudgetSpent } from "./budget";
import { cleanSettings, getSettings, getValue, profileReady, saveSettings, setValue, SOURCES, type Source } from "./settings";

type Row = Record<string, unknown>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const clampInt = (v: string | null, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return v !== null && v !== "" && Number.isFinite(n) ? Math.min(Math.max(Math.round(n), min), max) : fallback;
};
const sourcesOf = (v: unknown): Source[] => {
  const list = Array.isArray(v) ? v.map(String) : String(v ?? "").split(",");
  const picked = list.filter((s): s is Source => SOURCES.includes(s as Source));
  return picked.length ? picked : SOURCES;
};

async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.method === "GET" || request.method === "DELETE") return {};
  return ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
}

export async function api(request: Request, env: SniffEnv, url: URL): Promise<Response> {
  const path = url.pathname;
  const m = request.method;
  const b = await body(request);
  const db = env.SNIFF_DB;

  if (m === "GET" && path === "/api/status") {
    const settings = await getSettings(db);
    const topics = await listTopics(db, true);
    const lastRuns = Object.fromEntries(await Promise.all(SOURCES.map(async (s) => [s, (await getValue<number>(db, `last_${s}`)) || null])));
    return json({
      ready: profileReady(settings.profile),
      topics: topics.length,
      ai: await aiStatus(env),
      stackExchangeKey: Boolean(env.STACKEXCHANGE_KEY),
      webhook: Boolean(env.SNIFF_WEBHOOK_URL),
      lastRuns,
    });
  }

  if (path === "/api/settings") {
    if (m === "GET") return json(await getSettings(db));
    if (m === "PUT") {
      const next = cleanSettings(b, await getSettings(db));
      await saveSettings(db, next);
      return json(next);
    }
  }

  if (m === "GET" && path === "/api/posts") {
    const status = url.searchParams.get("status") ?? "open";
    const min = clampInt(url.searchParams.get("min"), 0, 0, 100);
    const days = clampInt(url.searchParams.get("days"), 14, 1, 180);
    const pageSize = clampInt(url.searchParams.get("pageSize"), 25, 5, 100);
    const page = clampInt(url.searchParams.get("page"), 1, 1, 10_000);
    const where = ["posted_at >= ?1", "COALESCE(relevance, 0) >= ?2"];
    const params: unknown[] = [new Date(Date.now() - days * 86_400_000).toISOString(), min];
    if (status === "open") where.push("status IN ('new', 'seen')");
    else if (["new", "seen", "replied", "dismissed"].includes(status)) { params.push(status); where.push(`status = ?${params.length}`); }
    const topic = url.searchParams.get("topic");
    if (topic) { params.push(topic); where.push(`topic_id = ?${params.length}`); }
    const source = url.searchParams.get("source");
    if (source && SOURCES.includes(source as Source)) { params.push(source); where.push(`source = ?${params.length}`); }
    const [list, count, unrated] = await Promise.all([
      db.prepare(`SELECT * FROM posts WHERE ${where.join(" AND ")} ORDER BY (relevance IS NULL), relevance DESC, posted_at DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`).bind(...params).all<Row>(),
      db.prepare(`SELECT count(*) AS n FROM posts WHERE ${where.join(" AND ")}`).bind(...params).first<{ n: number }>(),
      db.prepare(`SELECT count(*) AS n FROM posts WHERE relevance IS NULL`).first<{ n: number }>(),
    ]);
    return json({
      total: count?.n ?? 0, page, pageSize, unrated: unrated?.n ?? 0,
      posts: list.results.map((p) => ({
        id: p.id, source: p.source, url: p.url, title: p.title, body: p.body, author: p.author, community: p.community,
        postedAt: p.posted_at, score: p.score, comments: p.comments, topicId: p.topic_id,
        relevance: p.relevance, intent: p.intent, summary: p.summary,
        painPoints: (() => { try { return JSON.parse(String(p.pain_points ?? "[]")); } catch { return []; } })(),
        replyDraft: p.reply_draft, status: p.status, statusAt: p.status_at,
      })),
    });
  }
  const one = path.match(/^\/api\/posts\/([^/]+)$/);
  if (one && m === "POST") {
    const status = String(b.status ?? "");
    if (!["new", "seen", "replied", "dismissed"].includes(status)) return json({ error: "status is new, seen, replied or dismissed" }, 400);
    await db.prepare(`UPDATE posts SET status = ?2, status_at = CURRENT_TIMESTAMP WHERE id = ?1`).bind(decodeURIComponent(one[1]!), status).run();
    return json({ ok: true });
  }
  const again = path.match(/^\/api\/posts\/([^/]+)\/redraft$/);
  if (again && m === "POST") {
    try {
      return json({ replyDraft: await redraft(env, decodeURIComponent(again[1]!), str(b.instruction, 1000) ?? undefined) });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, e instanceof AiBudgetSpent ? 429 : 400);
    }
  }

  if (path === "/api/topics") {
    if (m === "GET") {
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const { results } = await db.prepare(
        `SELECT t.*, (SELECT count(*) FROM posts p WHERE p.topic_id = t.id AND p.posted_at >= ?1) AS week FROM topics t ORDER BY t.created_at`,
      ).bind(since).all<Row>();
      return json({ topics: results.map((t) => ({ id: t.id, name: t.name, query: t.query, sources: String(t.sources).split(","), enabled: Boolean(Number(t.enabled)), postsThisWeek: Number(t.week) || 0 })) });
    }
    if (m === "POST") {
      const name = str(b.name, 80), query = str(b.query, 300);
      if (!name || !query) return json({ error: "A name and search terms are needed" }, 400);
      const id = crypto.randomUUID();
      await db.prepare(`INSERT INTO topics (id, name, query, sources) VALUES (?1, ?2, ?3, ?4)`).bind(id, name, query, sourcesOf(b.sources).join(",")).run();
      return json({ ok: true, id }, 201);
    }
  }
  const topic = path.match(/^\/api\/topics\/([^/]+)$/);
  if (topic && m === "PUT") {
    const name = str(b.name, 80), query = str(b.query, 300);
    if (!name || !query) return json({ error: "A name and search terms are needed" }, 400);
    await db.prepare(`UPDATE topics SET name = ?2, query = ?3, sources = ?4, enabled = ?5 WHERE id = ?1`)
      .bind(decodeURIComponent(topic[1]!), name, query, sourcesOf(b.sources).join(","), b.enabled === false ? 0 : 1).run();
    return json({ ok: true });
  }
  if (topic && m === "DELETE") {
    await db.prepare(`DELETE FROM topics WHERE id = ?1`).bind(decodeURIComponent(topic[1]!)).run();
    return json({ ok: true });
  }

  if (m === "POST" && path === "/api/run") return json(await run(env, Date.now(), true));

  if (m === "GET" && path === "/api/insights") {
    const days = clampInt(url.searchParams.get("days"), 30, 7, 180);
    const settings = await getSettings(db);
    return json({ ...(await insights(db, days, settings.hotRelevance)), summary: await getValue(db, "market_summary") });
  }
  if (m === "POST" && path === "/api/summary") {
    const days = Math.min(Math.max(Math.round(Number(b.days) || 30), 7), 180);
    try {
      const value = { text: await marketSummary(env, days), days, at: new Date().toISOString() };
      await setValue(db, "market_summary", value);
      return json(value);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, e instanceof AiBudgetSpent ? 429 : 400);
    }
  }
  return json({ error: "Not found" }, 404);
}
