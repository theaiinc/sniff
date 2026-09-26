import { describe, expect, test } from "vitest";
import {
  cleanSettings, DEFAULT_SETTINGS, digestText, draftPrompt, fromHn, fromStackExchange, neurons, parseReading, parseRedditAtom,
  plainText, profileReady, ratingPrompt, stackExchangeCalls, terms, tidyDraft, topicFor, mentions, dailyLimit,
  checkBudget, recordSpend, spentToday, AiBudgetSpent,
} from "../src/core";
import { tokenMatches } from "../src/index";

const PROFILE = { name: "Acme", url: "https://acme.example", description: "Acme finds bugs before users do.", domain: "software testing", problems: "flaky tests, slow suites" };

const entry = `<entry><author><name>/u/someone</name></author><category term="QualityAssurance" label="r/QualityAssurance"/><content type="html">&lt;div class=&quot;md&quot;&gt;&lt;p&gt;Looking at QA automation &amp;amp; more.&lt;/p&gt;&lt;/div&gt; &amp;#32; submitted by &amp;#32; &lt;a href=&quot;https://www.reddit.com/user/someone&quot;&gt; /u/someone &lt;/a&gt;</content><id>t3_1abcde</id><link href="https://www.reddit.com/r/QualityAssurance/comments/1abcde/x/" /><updated>2026-09-24T10:00:00+00:00</updated><published>2026-09-24T09:58:00+00:00</published><title>Which tool for E2E?</title></entry>`;

describe("sources", () => {
  test("reads Reddit's feed: post, subreddit, author, clean text", () => {
    const [post] = parseRedditAtom(`<feed>${entry}</feed>`);
    expect(post).toMatchObject({ source: "reddit", externalId: "t3_1abcde", title: "Which tool for E2E?", author: "someone", community: "r/QualityAssurance", body: "Looking at QA automation & more." });
  });
  test("maps Hacker News and Stack Exchange items", () => {
    expect(fromHn({ objectID: "43", story_title: "Show HN: X", comment_text: "We use Cypress", created_at: "2026-09-24T10:00:00Z", _tags: ["comment"] }).title).toBe("Comment on: Show HN: X");
    expect(fromStackExchange("stackoverflow", { question_id: 7, title: "Waits &amp; retries", body: "<p>How?</p>", link: "https://stackoverflow.com/q/7", creation_date: 1790200000, score: 2, answer_count: 0 }))
      .toMatchObject({ externalId: "stackoverflow:7", title: "Waits & retries", community: "Stack Overflow" });
    expect(fromStackExchange("sqa", { question_id: 1, title: "t", link: "l", creation_date: 1, score: 0, answer_count: 0 }).community).toBe("sqa.stackexchange");
  });
  test("one Stack Exchange request per tag, and only two without a key", () => {
    const feeds = [{ site: "sqa", tags: [] }, { site: "stackoverflow", tags: ["playwright", "cypress"] }];
    expect(stackExchangeCalls(feeds, true)).toEqual([{ site: "sqa" }, { site: "stackoverflow", tag: "playwright" }, { site: "stackoverflow", tag: "cypress" }]);
    expect(stackExchangeCalls(feeds, false)).toHaveLength(2);
  });
});

describe("matching", () => {
  test("splits OR queries and cleans HTML", () => {
    expect(terms('"qa automation" OR playwright or  cypress')).toEqual(['"qa automation"', "playwright", "cypress"]);
    expect(plainText("<p>a &lt;b&gt;</p><p>c&#x27;d</p>")).toBe("a <b>\nc'd");
  });
  test("phrases must appear as written, bare terms as whole words", () => {
    const q = '"qa automation" OR playwright';
    expect(mentions(q, "Looking into QA automation tools")).toBe(true);
    expect(mentions(q, "qa-automation role")).toBe(true);
    expect(mentions(q, "automation for QA teams")).toBe(false);
    expect(mentions(q, "playwrights guild")).toBe(false);
  });
  test("a post goes to the first topic whose terms it mentions", () => {
    const list = [
      { id: "flaky", name: "Flaky", query: '"flaky tests"', sources: [] },
      { id: "e2e", name: "E2E", query: '"e2e testing"', sources: [] },
    ] as never;
    const post = (title: string) => ({ source: "reddit", externalId: "x", url: "u", title, body: null, author: null, community: null, postedAt: "", score: null, comments: null }) as never;
    expect(topicFor(list, post("Our e2e testing is full of flaky tests"))?.id).toBe("flaky");
    expect(topicFor(list, post("Hiring a tester"))).toBeNull();
  });
});

describe("settings", () => {
  test("start empty, so nothing is rated until a product is described", () => {
    expect(profileReady(DEFAULT_SETTINGS.profile)).toBe(false);
    expect(profileReady(PROFILE)).toBe(true);
  });
  test("are trimmed, bounded and cleaned", () => {
    const s = cleanSettings({
      profile: { ...PROFILE, url: "acme.example", name: "  Acme  " },
      communities: { subreddits: "r/QualityAssurance, bad name!, Playwright", stackexchange: [{ site: "StackOverflow", tags: ["Playwright"] }, { site: "../evil" }] },
      hotRelevance: 250,
      unexpected: "dropped",
    });
    expect(s.profile.name).toBe("Acme");
    expect(s.profile.url).toBe("https://acme.example");
    expect(s.communities.subreddits).toEqual(["QualityAssurance", "Playwright"]);
    expect(s.communities.stackexchange).toEqual([{ site: "stackoverflow", tags: ["playwright"] }]);
    expect(s.hotRelevance).toBe(100);
    expect(s).not.toHaveProperty("unexpected");
  });
});

describe("prompts", () => {
  test("come from the profile, with no product baked in", () => {
    const rating = ratingPrompt(PROFILE);
    expect(rating).toContain("Acme (acme.example): Acme finds bugs");
    expect(rating).toContain("which tool or service to use for software testing");
    expect(rating).toContain("(flaky tests, slow suites)");
    const draft = draftPrompt(PROFILE, "r/QualityAssurance", "Write as Ann.", "Shorter");
    expect(draft).toContain('"(I work on Acme.)"');
    expect(draft).toContain("No links except acme.example");
    expect(draft).toContain("Write as Ann.");
    expect(draft).toContain("For this reply specifically: Shorter");
  });
  test("a dangling disclosure is dropped; one that goes with a mention stays", () => {
    expect(tidyDraft("Use role-based locators. (I work on Acme.)", "Acme")).toBe("Use role-based locators.");
    expect(tidyDraft("Acme can write these for you. (I work on Acme.)", "Acme")).toBe("Acme can write these for you. (I work on Acme.)");
  });
  test("readings are parsed and clamped, even from slightly broken JSON", () => {
    expect(parseReading('Sure! {"relevance": 140, "intent": "asking_for_tool", "summary": "Wants a tool", "pain_points": ["flaky tests"]}'))
      .toEqual({ relevance: 100, intent: "asking_for_tool", summary: "Wants a tool", painPoints: ["flaky tests"] });
    expect(parseReading('{"relevance": 80, "intent": "discussion", "summary": "x", "pain_points": "a", "b"}')?.painPoints).toEqual(["a", "b"]);
    expect(parseReading("no json")).toBeNull();
  });
});

function fakeDb() {
  const rows = new Map<string, string>();
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind: (...a: unknown[]) => { args = a; return stmt; },
        first: async () => (rows.has(String(args[0])) ? { value_json: rows.get(String(args[0])) } : null),
        run: async () => {
          if (sql.startsWith("INSERT")) rows.set(String(args[0]), String(args[1]));
          if (sql.startsWith("DELETE")) for (const k of [...rows.keys()]) if (k < String(args[0])) rows.delete(k);
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return { db: db as unknown as D1Database, rows };
}

describe("AI budget", () => {
  test("prices tokens and stops at the daily limit", async () => {
    expect(neurons({ prompt_tokens: 1000, completion_tokens: 100 }, 0, 0)).toBeCloseTo(47.15, 1);
    expect(dailyLimit(undefined)).toBe(5000);
    expect(dailyLimit("1200")).toBe(1200);
    const { db } = fakeDb();
    const day = Date.parse("2026-09-25T12:00:00Z");
    await recordSpend(db, 60, day);
    await recordSpend(db, 45, day);
    expect(await spentToday(db, day)).toBe(105);
    await expect(checkBudget(db, 100, day)).rejects.toBeInstanceOf(AiBudgetSpent);
    await checkBudget(db, 100, day + 86_400_000);
  });
});

describe("digest and access", () => {
  test("the digest lists the hot posts and links back", () => {
    const text = digestText([{ community: "r/QA", title: "Which tool?", relevance: 92, url: "https://reddit.com/x" }], "https://sniff.example.workers.dev/");
    expect(text).toBe("1 post worth answering\n• r/QA: Which tool? (fit 92) https://reddit.com/x\nDrafts: https://sniff.example.workers.dev/");
  });
  test("the admin token must match exactly, and be long enough to be a token", () => {
    const token = "x".repeat(32);
    expect(tokenMatches(`Bearer ${token}`, token)).toBe(true);
    expect(tokenMatches(`Bearer ${token}y`, token)).toBe(false);
    expect(tokenMatches(null, token)).toBe(false);
    expect(tokenMatches("Bearer short", "short")).toBe(false);
  });
});
