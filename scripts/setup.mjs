#!/usr/bin/env node
// One-time setup: creates the D1 database, writes wrangler.jsonc from the
// example with its id, applies the schema, and sets a random admin token.
// Run it logged in to Cloudflare (npx wrangler login). Idempotent.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const wrangler = (args, opts = {}) => execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "inherit"], ...opts });

if (!existsSync("wrangler.jsonc")) {
  writeFileSync("wrangler.jsonc", readFileSync("wrangler.example.jsonc", "utf8"));
  console.log("Created wrangler.jsonc from wrangler.example.jsonc");
}
let config = readFileSync("wrangler.jsonc", "utf8");
const name = config.match(/"database_name":\s*"([^"]+)"/)?.[1] ?? "sniff";

if (config.includes("REPLACE_WITH_YOUR_D1_DATABASE_ID")) {
  const list = JSON.parse(wrangler(["d1", "list", "--json"]));
  let id = list.find((d) => d.name === name)?.uuid;
  if (!id) {
    const out = wrangler(["d1", "create", name]);
    id = out.match(/"database_id":\s*"([0-9a-f-]{36})"/)?.[1] ?? out.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)?.[1];
    if (!id) throw new Error(`Couldn't read the new database id from wrangler:\n${out}`);
    console.log(`Created D1 database ${name}`);
  }
  config = config.replace("REPLACE_WITH_YOUR_D1_DATABASE_ID", id);
  writeFileSync("wrangler.jsonc", config);
  console.log("Wrote its id to wrangler.jsonc (git-ignored)");
}

console.log("Applying the schema…");
wrangler(["d1", "migrations", "apply", "SNIFF_DB", "--remote"], { stdio: "inherit" });

if (!process.argv.includes("--keep-token")) {
  const token = randomBytes(24).toString("base64url");
  // Sent on stdin, so it never appears in the process list or shell history.
  const r = spawnSync("npx", ["wrangler", "secret", "put", "SNIFF_ADMIN_TOKEN"], { input: token, stdio: ["pipe", "inherit", "inherit"] });
  if (r.status !== 0) throw new Error("Setting SNIFF_ADMIN_TOKEN failed. Deploy once (npm run deploy), then run setup again.");
  console.log("\nYour admin token (shown once; keep it in your password manager):\n\n  " + token + "\n");
}
console.log("Next: npm run deploy, open the address it prints, sign in with the token, then fill in Settings and add Topics.");
