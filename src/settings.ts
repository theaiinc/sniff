// What sniff listens for and on whose behalf. Kept in the database and edited
// from the web page (or the API), so a deployment needs no code changes.

export type Source = "reddit" | "hn" | "stackexchange";
export const SOURCES: Source[] = ["reddit", "hn", "stackexchange"];

/** The product replies are drafted for. Until it's filled in, posts are found but not rated. */
export type Profile = {
  /** "Acme" */
  name: string;
  /** "https://acme.example": the only link a draft may contain. */
  url: string;
  /** What it does, in two or three sentences. */
  description: string;
  /** The subject people discuss: "software testing", "personal finance". */
  domain: string;
  /** Problems it solves, as people would describe them: "flaky tests, no time to write tests". */
  problems: string;
};

export type StackExchangeFeed = {
  /** A Stack Exchange site's API name: "stackoverflow", "sqa", "superuser". */
  site: string;
  /** Tags to follow (one request each). Empty: every new question on the site. */
  tags: string[];
};

/** Places where everything is on topic: their new posts are kept even when no topic's words match. */
export type Communities = {
  /** Subreddit names without "r/". */
  subreddits: string[];
  stackexchange: StackExchangeFeed[];
};

export type Settings = {
  profile: Profile;
  communities: Communities;
  /** Standing instructions for every drafted reply (voice, what to stress or avoid). */
  replyGuidance: string;
  /** Posts at or above this relevance are "hot": drafted, and sent to the webhook. */
  hotRelevance: number;
};

export const EMPTY_PROFILE: Profile = { name: "", url: "", description: "", domain: "", problems: "" };

export const DEFAULT_SETTINGS: Settings = {
  profile: EMPTY_PROFILE,
  communities: { subreddits: [], stackexchange: [] },
  replyGuidance: "",
  hotRelevance: 70,
};

export const profileReady = (p: Profile) => Boolean(p.name.trim() && p.description.trim() && p.domain.trim());

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const list = (v: unknown, max: number, each = 80) =>
  (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\n,]+/) : [])
    .map((x) => String(x).trim().replace(/^r\//i, "").slice(0, each))
    .filter(Boolean)
    .slice(0, max);

/** Accepts settings from the API: trims, bounds and drops anything unexpected. */
export function cleanSettings(input: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const i = (input ?? {}) as Record<string, any>;
  const p = (i.profile ?? {}) as Record<string, unknown>;
  const c = (i.communities ?? {}) as Record<string, unknown>;
  const url = str(p.url ?? base.profile.url, 200);
  return {
    profile: {
      name: str(p.name ?? base.profile.name, 80),
      url: url && !/^https?:\/\//i.test(url) ? `https://${url}` : url,
      description: str(p.description ?? base.profile.description, 1200),
      domain: str(p.domain ?? base.profile.domain, 120),
      problems: str(p.problems ?? base.profile.problems, 600),
    },
    communities: {
      subreddits: c.subreddits !== undefined ? list(c.subreddits, 25, 50).filter((s) => /^[A-Za-z0-9_]{2,50}$/.test(s)) : base.communities.subreddits,
      stackexchange: c.stackexchange !== undefined
        ? (Array.isArray(c.stackexchange) ? c.stackexchange : [])
          .map((f: any) => ({ site: str(f?.site, 60).toLowerCase(), tags: list(f?.tags, 15, 35).map((t) => t.toLowerCase()) }))
          .filter((f) => /^[a-z0-9.-]{2,60}$/.test(f.site))
          .slice(0, 6)
        : base.communities.stackexchange,
    },
    replyGuidance: i.replyGuidance !== undefined ? str(i.replyGuidance, 2000) : base.replyGuidance,
    hotRelevance: i.hotRelevance !== undefined
      ? Math.min(100, Math.max(0, Math.round(Number(i.hotRelevance)) || base.hotRelevance))
      : base.hotRelevance,
  };
}

export async function getSettings(db: D1Database): Promise<Settings> {
  const row = await db.prepare(`SELECT value_json FROM settings WHERE key = 'settings'`).first<{ value_json: string }>();
  if (!row) return DEFAULT_SETTINGS;
  try {
    return cleanSettings(JSON.parse(row.value_json));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(db: D1Database, settings: Settings): Promise<void> {
  await setValue(db, "settings", settings);
}

export async function getValue<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await db.prepare(`SELECT value_json FROM settings WHERE key = ?1`).bind(key).first<{ value_json: string }>();
  try {
    return row ? (JSON.parse(row.value_json) as T) : null;
  } catch {
    return null;
  }
}

export async function setValue(db: D1Database, key: string, value: unknown): Promise<void> {
  await db.prepare(
    `INSERT INTO settings (key, value_json) VALUES (?1, ?2)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP`,
  ).bind(key, JSON.stringify(value)).run();
}
