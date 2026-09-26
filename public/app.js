// sniff's web page: no framework, no build. The admin token is kept in this
// browser only (localStorage) and sent as a bearer token to /api/*.
const $ = (sel, root = document) => root.querySelector(sel);
const app = $("#app");
const TOKEN_KEY = "sniff.token";
const store = {
  get: () => { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } },
  set: (v) => { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ } },
};

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    // Through CSSOM: the page's CSP blocks style="" attributes.
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

async function call(method, path, body) {
  const res = await fetch(`/api/${path}`, {
    method,
    headers: { authorization: `Bearer ${store.get()}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { store.set(""); login("That token didn't work."); throw new Error("Signed out"); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const when = (iso) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const SOURCE = { reddit: "Reddit", hn: "Hacker News", stackexchange: "Stack Exchange" };
const INTENT = { asking_for_tool: "Looking for a tool", problem: "Has a problem", discussion: "Discussion", job: "Job post", promotion: "Promotion", other: "Other" };

// ── Sign in ──

function login(message) {
  $("#tabs").hidden = true;
  $("#signout").hidden = true;
  const input = h("input", { type: "password", autocomplete: "current-password", placeholder: "SNIFF_ADMIN_TOKEN", required: true });
  app.replaceChildren(h("form", { class: "card login", onsubmit: async (e) => {
    e.preventDefault();
    store.set(input.value.trim());
    try { await call("GET", "status"); start(); } catch { /* call() shows the message */ }
  } },
  h("h2", {}, "Sign in to sniff"),
  h("p", { class: "muted small" }, "Paste the admin token you set with ", h("code", {}, "wrangler secret put SNIFF_ADMIN_TOKEN"), ". It stays in this browser."),
  input,
  message ? h("p", { class: "status err" }, message) : null,
  h("div", { class: "row", }, h("button", { class: "primary", type: "submit" }, "Sign in"))));
  input.focus();
}

// ── Tabs ──

let current = "posts";
const tabs = { posts, topics, market, settings };
function show(tab) {
  current = tab;
  for (const b of document.querySelectorAll("#tabs button")) {
    if (b.dataset.tab === tab) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  app.replaceChildren(h("p", { class: "muted" }, "Loading…"));
  tabs[tab]().catch((e) => app.replaceChildren(h("p", { class: "status err" }, e.message)));
}
async function start() {
  $("#tabs").hidden = false;
  $("#signout").hidden = false;
  show(current);
}
document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => show(b.dataset.tab)));
$("#signout").addEventListener("click", () => { store.set(""); login(); });

async function notices() {
  const s = await call("GET", "status");
  const out = [];
  if (!s.ready) out.push(h("div", { class: "notice" }, "Posts are found but not rated until you describe your product. ", h("button", { class: "ghost", onclick: () => show("settings") }, "Open Settings →")));
  if (!s.topics) out.push(h("div", { class: "notice" }, "Add a topic so sniff knows what to search for. ", h("button", { class: "ghost", onclick: () => show("topics") }, "Add topics →")));
  if (!s.ai.bound) out.push(h("div", { class: "notice" }, "Workers AI isn't bound: add \"ai\": { \"binding\": \"AI\" } to wrangler.jsonc."));
  else if (s.ai.left <= 0) out.push(h("div", { class: "notice" }, "Today's AI allowance is used up; rating resumes at 00:00 UTC."));
  return { status: s, nodes: out };
}

// ── Posts ──

const filters = { status: "open", min: "40", source: "", days: "14", page: 1 };
async function posts() {
  const { status, nodes } = await notices();
  const q = new URLSearchParams({ status: filters.status, min: filters.min, source: filters.source, days: filters.days, page: String(filters.page), pageSize: "25" });
  const data = await call("GET", `posts?${q}`);
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const select = (key, options) => h("select", { onchange: (e) => { filters[key] = e.target.value; filters.page = 1; show("posts"); } },
    options.map(([v, label]) => h("option", { value: v, selected: filters[key] === v }, label)));
  app.replaceChildren(
    ...nodes,
    h("div", { class: "grid" },
      h("div", {}, h("label", {}, "Show"), select("status", [["open", "To answer"], ["replied", "Replied"], ["dismissed", "Dismissed"], ["all", "All"]])),
      h("div", {}, h("label", {}, "Fit at least"), select("min", [["70", "70 (hot)"], ["40", "40"], ["0", "Everything"]])),
      h("div", {}, h("label", {}, "Where"), select("source", [["", "Everywhere"], ["reddit", "Reddit"], ["hn", "Hacker News"], ["stackexchange", "Stack Exchange"]])),
      h("div", {}, h("label", {}, "Posted in"), select("days", [["1", "Last day"], ["7", "Last week"], ["14", "Last 2 weeks"], ["30", "Last month"], ["90", "Last 3 months"]])),
    ),
    h("p", { class: "muted small" },
      `${data.total} post(s)`,
      data.unrated ? ` · ${data.unrated} waiting to be rated` : "",
      status.ai.bound ? ` · AI today: ${status.ai.spent.toLocaleString()} of ${status.ai.limit.toLocaleString()} neurons` : ""),
    ...data.posts.map(postCard),
    data.posts.length ? null : h("p", { class: "muted" }, "Nothing here yet. Lower \"Fit at least\", add topics, or run a search from Topics."),
    data.total > data.pageSize ? h("div", { class: "pager" },
      h("button", { disabled: filters.page <= 1, onclick: () => { filters.page--; show("posts"); scrollTo(0, 0); } }, "← Previous"),
      h("span", { class: "muted small" }, `Page ${filters.page} of ${pages}`),
      h("button", { disabled: filters.page >= pages, onclick: () => { filters.page++; show("posts"); scrollTo(0, 0); } }, "Next →")) : null,
  );
}

function postCard(p) {
  const tone = p.relevance == null ? "" : p.relevance >= 70 ? "hot" : p.relevance >= 40 ? "warm" : "";
  const mark = async (s) => { await call("POST", `posts/${encodeURIComponent(p.id)}`, { status: s }); show("posts"); };
  const draft = h("div", { class: "draft", hidden: !p.replyDraft }, p.replyDraft || "");
  const instruction = h("input", { placeholder: p.replyDraft ? "How should it change? e.g. shorter, ask about their setup" : "Anything to steer the draft? (optional)", maxlength: "1000" });
  const note = h("p", { class: "status" });
  const redraft = h("button", { onclick: async () => {
    redraft.disabled = true; note.textContent = "Writing…"; note.className = "status";
    try {
      const r = await call("POST", `posts/${encodeURIComponent(p.id)}/redraft`, { instruction: instruction.value });
      draft.textContent = r.replyDraft; draft.hidden = false; instruction.value = ""; note.textContent = "";
    } catch (e) { note.textContent = e.message; note.className = "status err"; }
    redraft.disabled = false;
  } }, p.replyDraft ? "Redraft" : "Draft a reply");
  const open = () => { window.open(p.url, "_blank", "noopener"); if (p.status === "new") call("POST", `posts/${encodeURIComponent(p.id)}`, { status: "seen" }).catch(() => {}); };
  return h("article", { class: `card post${p.status === "new" ? " new" : ""}` },
    h("div", { class: "meta" },
      h("b", {}, p.community || SOURCE[p.source]), h("span", {}, when(p.postedAt)), p.author ? h("span", {}, `by ${p.author}`) : null,
      h("span", { class: "right" }, p.intent ? h("span", { class: "pill" }, INTENT[p.intent] || p.intent) : null,
        h("span", { class: `pill ${tone}` }, p.relevance == null ? "Not rated yet" : `Fit ${p.relevance}`))),
    h("h3", {}, h("a", { href: p.url, target: "_blank", rel: "noopener", onclick: (e) => { e.preventDefault(); open(); } }, p.title || "(untitled)")),
    h("p", { class: "muted small" }, p.summary || (p.body || "").slice(0, 280)),
    p.painPoints.length ? h("div", { class: "tags" }, p.painPoints.map((x) => h("span", {}, x))) : null,
    draft,
    p.relevance != null ? h("div", { class: "row", }, instruction, redraft,
      p.replyDraft ? h("button", { onclick: () => navigator.clipboard?.writeText(draft.textContent) }, "Copy") : null) : null,
    note,
    h("div", { class: "row" },
      h("button", { onclick: open }, "Open"),
      p.status !== "replied" ? h("button", { onclick: () => mark("replied") }, "Replied") : null,
      p.status !== "dismissed" ? h("button", { class: "ghost", onclick: () => mark("dismissed") }, "Not for us") : null),
  );
}

// ── Topics ──

async function topics() {
  const [{ topics: list }, status] = await Promise.all([call("GET", "topics"), call("GET", "status")]);
  const name = h("input", { placeholder: "Flaky tests", required: true, maxlength: "80" });
  const query = h("input", { placeholder: "\"flaky tests\" OR \"flaky test\"", required: true, maxlength: "300" });
  const note = h("p", { class: "status" });
  const runNote = h("p", { class: "status" });
  const runBtn = h("button", { onclick: async () => {
    runBtn.disabled = true; runNote.textContent = "Searching…"; runNote.className = "status";
    try {
      const r = await call("POST", "run");
      runNote.textContent = `${r.found} new post(s), ${r.rated} rated.${r.errors.length ? " " + r.errors.join(" · ") : ""}`;
    } catch (e) { runNote.textContent = e.message; runNote.className = "status err"; }
    runBtn.disabled = false;
  } }, "Search now");
  const last = Object.entries(status.lastRuns).map(([s, t]) => `${SOURCE[s]}: ${t ? when(new Date(t).toISOString()) : "never"}`).join(" · ");
  app.replaceChildren(
    h("div", { class: "card" },
      h("div", { class: "row" }, h("h2", { }, "What to listen for"), h("span", { style: "flex:1" }), runBtn),
      h("p", { class: "muted small" }, "Reddit and Hacker News are searched every 15 minutes, Stack Exchange every 2 hours. Use OR between terms and quotes for phrases. ", last),
      runNote,
      ...list.map((t) => h("div", { class: "row card", },
        h("input", { type: "checkbox", checked: t.enabled, style: "width:auto", "aria-label": `Listen for ${t.name}`, onchange: async (e) => { await call("PUT", `topics/${t.id}`, { ...t, enabled: e.target.checked }); } }),
        h("div", { style: "flex:1;min-width:0" }, h("b", {}, t.name), h("span", { class: "muted small" }, ` · ${t.postsThisWeek} this week`), h("div", { class: "muted small" }, t.query)),
        h("button", { class: "ghost", onclick: async () => { if (confirm(`Stop listening for ${t.name}?`)) { await call("DELETE", `topics/${t.id}`); show("topics"); } } }, "Delete"))),
      h("form", { onsubmit: async (e) => {
        e.preventDefault();
        try { await call("POST", "topics", { name: name.value, query: query.value }); show("topics"); }
        catch (err) { note.textContent = err.message; note.className = "status err"; }
      } },
      h("div", { class: "grid" }, h("div", {}, h("label", {}, "Topic"), name), h("div", {}, h("label", {}, "Search terms"), query)),
      h("div", { class: "row", style: "margin-top:10px" }, h("button", { class: "primary", type: "submit" }, "Add topic")),
      note)),
  );
}

// ── Market ──

async function market() {
  const data = await call("GET", "insights?days=30");
  const bars = (items, label, value) => {
    const max = Math.max(1, ...items.map(value));
    return h("div", { class: "bars" }, items.map((x) => h("div", {}, h("b", { title: label(x) }, label(x)), h("i", { style: `width:${Math.round((value(x) / max) * 50)}%` }), h("span", { class: "muted" }, String(value(x))))));
  };
  const summaryBox = h("pre", { class: "summary" }, data.summary ? data.summary.text : "No brief yet.");
  const note = h("p", { class: "status" });
  const write = h("button", { onclick: async () => {
    write.disabled = true; note.textContent = "Writing…"; note.className = "status";
    try { const r = await call("POST", "summary", { days: 30 }); summaryBox.textContent = r.text; note.textContent = ""; }
    catch (e) { note.textContent = e.message; note.className = "status err"; }
    write.disabled = false;
  } }, "Write a new brief");
  app.replaceChildren(
    h("div", { class: "grid" },
      h("div", { class: "card" }, h("p", { class: "muted small" }, "Posts, 30 days"), h("h2", {}, String(data.totals.posts))),
      h("div", { class: "card" }, h("p", { class: "muted small" }, "Worth answering"), h("h2", {}, String(data.totals.hot))),
      h("div", { class: "card" }, h("p", { class: "muted small" }, "Replied"), h("h2", {}, String(data.totals.replied)))),
    h("div", { class: "card" }, h("div", { class: "row" }, h("h2", {}, "Market brief"), h("span", { style: "flex:1" }), write),
      data.summary ? h("p", { class: "muted small" }, `Written ${when(data.summary.at)} from ${data.summary.days} days of posts.`) : null, summaryBox, note),
    h("div", { class: "card" }, h("h2", {}, "Pain points"), data.painPoints.length ? bars(data.painPoints, (x) => x.point, (x) => x.posts) : h("p", { class: "muted" }, "None yet.")),
    h("div", { class: "card" }, h("h2", {}, "Where"), bars(data.communities, (x) => x.community, (x) => x.posts)),
    h("div", { class: "card" }, h("h2", {}, "What people want"), bars(data.intents, (x) => INTENT[x.intent] || x.intent, (x) => x.posts)),
  );
}

// ── Settings ──

async function settings() {
  const [s, status] = await Promise.all([call("GET", "settings"), call("GET", "status")]);
  const field = (label, hint, el) => h("div", {}, h("label", {}, label, hint ? h("span", {}, ` ${hint}`) : null), el);
  const f = {
    name: h("input", { value: s.profile.name, maxlength: "80", placeholder: "Acme" }),
    url: h("input", { value: s.profile.url, maxlength: "200", placeholder: "https://acme.example" }),
    domain: h("input", { value: s.profile.domain, maxlength: "120", placeholder: "software testing" }),
    description: h("textarea", { maxlength: "1200", rows: "3", placeholder: "What it does, for whom, and whether there's a free plan." }, s.profile.description),
    problems: h("textarea", { maxlength: "600", rows: "2", placeholder: "flaky tests, no time to write tests, testing mobile apps" }, s.profile.problems),
    subreddits: h("input", { value: s.communities.subreddits.join(", "), placeholder: "QualityAssurance, softwaretesting" }),
    stackexchange: h("textarea", { rows: "3", placeholder: "sqa\nstackoverflow: playwright, cypress" }, s.communities.stackexchange.map((x) => x.tags.length ? `${x.site}: ${x.tags.join(", ")}` : x.site).join("\n")),
    guidance: h("textarea", { maxlength: "2000", rows: "3", placeholder: "Write as a QA engineer. Never criticise other tools. Ask one question back." }, s.replyGuidance),
    hot: h("input", { type: "number", min: "0", max: "100", value: String(s.hotRelevance) }),
  };
  const note = h("p", { class: "status" });
  app.replaceChildren(h("form", { onsubmit: async (e) => {
    e.preventDefault();
    const stackexchange = f.stackexchange.value.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const [site, tags = ""] = l.split(":");
      return { site: site.trim(), tags: tags.split(",").map((t) => t.trim()).filter(Boolean) };
    });
    try {
      await call("PUT", "settings", {
        profile: { name: f.name.value, url: f.url.value, domain: f.domain.value, description: f.description.value, problems: f.problems.value },
        communities: { subreddits: f.subreddits.value, stackexchange },
        replyGuidance: f.guidance.value,
        hotRelevance: Number(f.hot.value),
      });
      note.textContent = "Saved."; note.className = "status";
    } catch (err) { note.textContent = err.message; note.className = "status err"; }
  } },
  h("div", { class: "card" },
    h("h2", {}, "Your product"),
    h("p", { class: "muted small" }, "Posts are rated and replies drafted on behalf of this product. Nothing is ever posted for you."),
    h("div", { class: "grid" }, field("Name", "", f.name), field("Website", "(the only link drafts may use)", f.url)),
    field("Subject", "(what people discuss)", f.domain),
    field("What it does", "", f.description),
    field("Problems it solves", "(as people would describe them)", f.problems)),
  h("div", { class: "card" },
    h("h2", {}, "Communities"),
    h("p", { class: "muted small" }, "Places where every new post is on topic. They're read in full, whatever words the posts use."),
    field("Subreddits", "(comma-separated, without r/)", f.subreddits),
    field("Stack Exchange", `(one per line: "site" for all new questions, or "site: tag, tag"${status.stackExchangeKey ? "" : "; without STACKEXCHANGE_KEY only the first two requests run"})`, f.stackexchange)),
  h("div", { class: "card" },
    h("h2", {}, "Replies"),
    field("Instructions for every draft", "", f.guidance),
    field("Hot from fit", `(sent to the webhook${status.webhook ? "" : ", which isn't set"})`, f.hot)),
  h("div", { class: "row" }, h("button", { class: "primary", type: "submit" }, "Save settings")),
  note));
}

store.get() ? call("GET", "status").then(start, () => {}) : login();
