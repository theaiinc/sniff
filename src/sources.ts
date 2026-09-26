// Where posts come from: Reddit (search and subreddit RSS), Hacker News
// (Algolia) and Stack Exchange (API). All read-only and public.
import type { Communities, Source } from "./settings";
import { decodeEntities, plainText, terms } from "./text";

export const USER_AGENT = "sniff/0.1 (+https://github.com/theaiinc/sniff; social listening)";

export type Found = {
  /** From a place where everything is on topic (a listed subreddit or site): kept even when no topic's words match. */
  fromCommunity?: boolean;
  source: Source;
  externalId: string;
  url: string;
  title: string | null;
  body: string | null;
  author: string | null;
  community: string | null;
  postedAt: string;
  score: number | null;
  comments: number | null;
};

export type Topic = { id: string; name: string; query: string; sources: Source[] };

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Reddit ──

/** Reddit's search RSS (Atom). Its JSON API needs an approved app; the feed doesn't. */
export function parseRedditAtom(xml: string): Found[] {
  const out: Found[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1]!;
    const get = (re: RegExp) => e.match(re)?.[1] ?? null;
    const id = get(/<id>([^<]+)<\/id>/);
    const url = get(/<link href="([^"]+)"/);
    if (!id || !url) continue;
    const posted = get(/<published>([^<]+)<\/published>/) ?? get(/<updated>([^<]+)<\/updated>/);
    const term = get(/<category[^>]*term="([^"]+)"/);
    out.push({
      source: "reddit",
      externalId: id,
      url: decodeEntities(url),
      title: plainText(get(/<title>([\s\S]*?)<\/title>/), 300),
      // The feed appends "submitted by /u/x to r/y [link] [comments]" to every post.
      body: plainText(decodeEntities(get(/<content[^>]*>([\s\S]*?)<\/content>/) ?? "").replace(/(&#32;|\s)*submitted by[\s\S]*$/, "")),
      author: get(/<author>\s*<name>([^<]+)<\/name>/)?.replace(/^\/u\//, "") ?? null,
      community: get(/<category[^>]*label="([^"]+)"/) ?? (term ? `r/${term}` : null),
      postedAt: posted ? new Date(posted).toISOString() : new Date().toISOString(),
      score: null,
      comments: null,
    });
  }
  return out;
}

async function redditFeed(url: string): Promise<Found[]> {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/atom+xml" } });
  if (!res.ok) throw new Error(`Reddit ${res.status}`);
  // Keep posts (t3_); search results also list matching subreddits (t5_).
  return parseRedditAtom(await res.text()).filter((p) => p.externalId.startsWith("t3_"));
}

/**
 * Reddit rate-limits shared cloud addresses quickly, so a run makes at most
 * two requests: one search for every topic at once, and the new posts of the
 * listed subreddits. Topics are matched afterwards.
 */
export async function reddit(topics: Topic[], subreddits: string[]): Promise<Found[]> {
  const out: Found[] = [];
  if (topics.length) {
    const query = topics.map((t) => `(${t.query})`).join(" OR ").slice(0, 500);
    out.push(...(await redditFeed(`https://www.reddit.com/search.rss?${new URLSearchParams({ q: query, sort: "new", t: "week", limit: "100" })}`)));
  }
  if (subreddits.length) {
    if (out.length) await pause(2500);
    const fresh = await redditFeed(`https://www.reddit.com/r/${subreddits.map(encodeURIComponent).join("+")}/new.rss?limit=100`).catch(() => [] as Found[]);
    out.push(...fresh.map((p) => ({ ...p, fromCommunity: true })));
  }
  return out;
}

// ── Hacker News ──

type HnHit = {
  objectID: string; title?: string | null; story_title?: string | null; comment_text?: string | null; story_text?: string | null;
  author?: string; created_at: string; points?: number | null; num_comments?: number | null; _tags?: string[];
};

export function fromHn(h: HnHit): Found {
  const isComment = h._tags?.includes("comment");
  return {
    source: "hn",
    externalId: h.objectID,
    url: `https://news.ycombinator.com/item?id=${h.objectID}`,
    title: plainText(h.title ?? (isComment ? `Comment on: ${h.story_title ?? "a story"}` : null), 300),
    body: plainText(h.comment_text ?? h.story_text ?? null),
    author: h.author ?? null,
    community: "Hacker News",
    postedAt: new Date(h.created_at).toISOString(),
    score: h.points ?? null,
    comments: h.num_comments ?? null,
  };
}

async function hnSearch(term: string, since: number): Promise<Found[]> {
  const q = new URLSearchParams({
    query: term, advancedSyntax: "true", tags: "(story,comment,ask_hn)", hitsPerPage: "40",
    numericFilters: `created_at_i>${Math.floor(since / 1000)}`,
  });
  const res = await fetch(`https://hn.algolia.com/api/v1/search_by_date?${q}`, { headers: { "user-agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Hacker News ${res.status}`);
  return ((await res.json()) as { hits: HnHit[] }).hits.map(fromHn);
}

export async function hn(topics: Topic[], since: number): Promise<Found[]> {
  const out: Found[] = [];
  for (const t of topics) out.push(...(await Promise.all(terms(t.query).map((term) => hnSearch(term, since)))).flat());
  return out;
}

// ── Stack Exchange ──

type SeItem = {
  question_id: number; title: string; body?: string; link: string; owner?: { display_name?: string };
  creation_date: number; score: number; answer_count: number;
};

const SITE_NAMES: Record<string, string> = { stackoverflow: "Stack Overflow", superuser: "Super User", serverfault: "Server Fault", askubuntu: "Ask Ubuntu" };
export const siteName = (site: string) => SITE_NAMES[site] ?? `${site}.stackexchange`;

export function fromStackExchange(site: string, q: SeItem): Found {
  return {
    source: "stackexchange",
    externalId: `${site}:${q.question_id}`,
    url: q.link,
    title: plainText(q.title, 300),
    body: plainText(q.body ?? null),
    author: q.owner?.display_name ? decodeEntities(q.owner.display_name) : null,
    community: siteName(site),
    postedAt: new Date(q.creation_date * 1000).toISOString(),
    score: q.score,
    comments: q.answer_count,
  };
}

/** The requests for a set of feeds: one per tag (tags are ANDed within a request), or one for a whole site. */
export function stackExchangeCalls(feeds: Communities["stackexchange"], hasKey: boolean): { site: string; tag?: string }[] {
  const calls = feeds.flatMap((f) => (f.tags.length ? f.tags.map((tag) => ({ site: f.site, tag })) : [{ site: f.site }]));
  // Without a key the quota shared by cloud addresses is tiny: keep to two requests.
  return hasKey ? calls.slice(0, 20) : calls.slice(0, 2);
}

export async function stackexchange(feeds: Communities["stackexchange"], since: number, key?: string): Promise<Found[]> {
  const out: Found[] = [];
  for (const { site, tag } of stackExchangeCalls(feeds, Boolean(key))) {
    const q = new URLSearchParams({ order: "desc", sort: "creation", pagesize: "50", filter: "withbody", fromdate: String(Math.floor(since / 1000)), site });
    if (tag) q.set("tagged", tag);
    if (key) q.set("key", key);
    const res = await fetch(`https://api.stackexchange.com/2.3/questions?${q}`, { headers: { "user-agent": USER_AGENT } });
    if (!res.ok) throw new Error(`Stack Exchange ${res.status}`);
    const data = (await res.json()) as { items?: SeItem[]; error_message?: string; backoff?: number };
    if (data.error_message) throw new Error(`Stack Exchange: ${data.error_message}`);
    // A whole site's new questions are all on topic; a tag's are matched against topics too.
    out.push(...(data.items ?? []).map((i) => ({ ...fromStackExchange(site, i), fromCommunity: true })));
    // Stack Exchange asks clients to wait when it says so.
    if (data.backoff) await pause(Math.min(data.backoff, 10) * 1000);
  }
  // The same question can carry several of the tags.
  return [...new Map(out.map((p) => [p.externalId, p])).values()];
}
