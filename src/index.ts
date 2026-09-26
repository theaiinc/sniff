// The sniff Worker: the web page (static assets), the API behind it, and the
// cron that listens. The API is guarded by SNIFF_ADMIN_TOKEN (a secret).
import { api } from "./api";
import { run, type SniffEnv } from "./core";

export interface Env extends SniffEnv {
  ASSETS: Fetcher;
  /** Bearer token for the API and the web page. Set with `wrangler secret put SNIFF_ADMIN_TOKEN`. */
  SNIFF_ADMIN_TOKEN?: string;
}

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function withHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** Constant-time comparison, so the token can't be guessed a character at a time. */
export function tokenMatches(header: string | null, token: string | undefined): boolean {
  if (!token || token.length < 24 || !header?.startsWith("Bearer ")) return false;
  const a = new TextEncoder().encode(header.slice(7));
  const b = new TextEncoder().encode(token);
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (!env.SNIFF_ADMIN_TOKEN || env.SNIFF_ADMIN_TOKEN.length < 24) {
        return withHeaders(Response.json({ error: "Set the SNIFF_ADMIN_TOKEN secret (24+ characters) first: npx wrangler secret put SNIFF_ADMIN_TOKEN" }, { status: 503 }));
      }
      if (!tokenMatches(request.headers.get("authorization"), env.SNIFF_ADMIN_TOKEN)) {
        return withHeaders(Response.json({ error: "Wrong or missing token" }, { status: 401 }));
      }
      return withHeaders(await api(request, env, url));
    }
    return withHeaders(await env.ASSETS.fetch(request));
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(run(env).then((r) => console.log("sniff run", JSON.stringify(r))));
  },
} satisfies ExportedHandler<Env>;
