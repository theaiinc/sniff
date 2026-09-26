// Turning feed HTML into plain text, and checking a post really says what a topic is about.

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function plainText(html: string | null | undefined, max = 1500): string | null {
  if (!html) return null;
  const text = decodeEntities(html.replace(/<(br|\/p|\/li|\/h\d)[^>]*>/gi, "\n").replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  return text ? text.slice(0, max) : null;
}

/** "a OR b" → ["a", "b"]; each is searched on its own where a source has no OR. */
export function terms(query: string): string[] {
  return query.split(/\s+OR\s+/i).map((t) => t.trim()).filter(Boolean).slice(0, 6);
}

/**
 * Whether a post really mentions one of the topic's terms: searches match
 * loosely (stems, other fields), so each hit is checked against its own text.
 * A quoted phrase must appear as written; a bare term as a whole word.
 */
export function mentions(query: string, text: string): boolean {
  const hay = text.toLowerCase();
  return terms(query).some((t) => {
    const phrase = t.replace(/^"|"$/g, "").toLowerCase().trim();
    if (!phrase) return false;
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s-]+");
    return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(hay);
  });
}

export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
