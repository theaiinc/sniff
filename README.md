# sniff

Social listening that runs on your own Cloudflare account. sniff watches
**Reddit**, **Hacker News** and **Stack Exchange** for posts about the problems
your product solves, has **Workers AI** rate how welcome a reply from you would
be, and drafts an honest, helpful reply for a person to review and post.

It never posts anything itself.

- **Find**: topics you define (`"flaky tests" OR "flaky test"`), plus every new post in the subreddits and Stack Exchange sites/tags you list.
- **Rate**: each post gets a fit score (0–100), the person's intent (looking for a tool, has a problem, discussion…), a one-line summary and their pain points.
- **Draft**: good fits get a reply that helps first and mentions your product only when it genuinely fits, with a disclosure. Steer drafts with standing instructions, or per post.
- **Understand the market**: pain points, communities and intents over time, plus an AI-written market brief.
- **Get pinged**: an optional hourly digest of hot posts to a Slack or Discord webhook.

Everything runs in one Worker with a D1 database, a cron trigger and Workers AI.
It stays inside the free Workers AI allowance by default.

## Deploy

You need Node 20+ and a Cloudflare account.

```bash
git clone https://github.com/theaiinc/sniff && cd sniff
npm install
npx wrangler login
npm run setup      # creates the D1 database, applies the schema, sets an admin token
npm run deploy
```

`npm run setup` prints an **admin token** once. Keep it in your password manager.
Open the address `npm run deploy` prints, sign in with the token, then:

1. **Settings → Your product**: name, website, the subject people discuss, what it does, the problems it solves. Posts aren't rated until this is filled in.
2. **Settings → Communities** (optional): subreddits and Stack Exchange sites or tags where every new post is on topic.
3. **Topics**: what to search for. Use `OR` between terms and quotes for phrases. Press **Search now** to try it.

After that, the cron runs every 15 minutes: Reddit and Hacker News every 15 minutes, Stack Exchange every 2 hours.

## Configuration

Nothing about your product lives in the code: it's all in **Settings**, stored in
your D1 database. Deployment settings are in `wrangler.jsonc`, which `npm run setup`
creates from [`wrangler.example.jsonc`](wrangler.example.jsonc). It holds your database id,
so it's git-ignored.

| Name | Kind | What it's for |
|---|---|---|
| `SNIFF_ADMIN_TOKEN` | secret, **required** | Bearer token for the web page and API (24+ characters). `npm run setup` generates one. |
| `STACKEXCHANGE_KEY` | secret, optional | A [Stack Apps](https://stackapps.com/apps/oauth/register) key: 10,000 requests a day instead of 300, and more than two Stack Exchange feeds. |
| `SNIFF_WEBHOOK_URL` | secret, optional | A Slack or Discord incoming webhook for the hourly digest of hot posts. |
| `SNIFF_AI_DAILY_NEURONS` | var | Daily Workers AI allowance in neurons. Default `5000`. Every account gets 10,000 free a day, shared by all its Workers. |
| `SNIFF_PUBLIC_URL` | var, optional | This deployment's address, for links in the digest. |

Set a secret with `npx wrangler secret put NAME`, which reads the value from your terminal,
so it never lands in a file or your shell history. For local development, put them in
`.dev.vars` (git-ignored).

### What it costs

The Worker, D1 and cron fit comfortably in Cloudflare's free tier. Rating a post uses
about 35 neurons and drafting a reply about 45, so the default 5,000 a day covers
roughly 100 new posts. When the day's allowance is used up, sniff stops asking the
model until 00:00 UTC; finding posts carries on. Posts are kept for 180 days (longer
if you marked them replied).

## Security

- The web page and every `/api/*` route need the admin token. It's compared in constant time, and the page keeps it only in your browser's local storage. For more, put the Worker behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/).
- Pages are served with a strict Content Security Policy (no inline scripts or styles, no framing).
- sniff only reads public feeds and APIs, and never posts or logs in anywhere.
- No secrets or deployment ids are ever committed: `npm run check:secrets` fails the build if something that looks like a key, webhook, account id or database id is tracked, and CI runs it on every push.

## Development

```bash
cp wrangler.example.jsonc wrangler.jsonc
echo 'SNIFF_ADMIN_TOKEN="a-local-token-at-least-24-chars"' > .dev.vars
npm run migrate:local
npm run dev
```

Workers AI always calls Cloudflare, even in local development. Set
`SNIFF_AI_DAILY_NEURONS="0"` in `.dev.vars` to try everything else without using any.

```bash
npm test             # unit tests
npm run typecheck
npm run check:secrets
```

### Using the engine elsewhere

`src/core.ts` exports the engine (`run`, `rate`, `redraft`, `insights`,
`marketSummary`, the sources and prompts) for use in another Worker. It needs a
D1 database with [the schema](migrations/0001_init.sql) bound as `SNIFF_DB`.

## How it decides what's relevant

A post is kept when it comes from one of your communities, or its title or body
really contains one of a topic's terms (searches match loosely, so every hit is
checked). The model then scores it against your product profile:

- **90–100**: asking which tool to use, or how to get started
- **70–89**: a concrete problem your product addresses
- **40–69**: a relevant discussion where an expert reply helps, but a product mention wouldn't fit
- **below 40**: passing mentions, unrelated uses of the words, job ads, self-promotion

Replies are drafted from 50 up, for people looking for a tool, describing a problem, or discussing one.
