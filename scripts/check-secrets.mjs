#!/usr/bin/env node
// Fails if anything that looks like a credential, a real deployment id or a
// local config file is tracked by git. Runs in CI and before every commit.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const forbiddenFiles = [/^wrangler\.jsonc$/, /(^|\/)\.dev\.vars$/, /(^|\/)\.env(\.|$)/, /\.pem$/, /\.key$/];
const patterns = [
  [/"database_id"\s*:\s*"(?!REPLACE_WITH_YOUR_D1_DATABASE_ID)[0-9a-f-]{36}"/i, "a real D1 database id"],
  [/"account_id"\s*:\s*"[0-9a-f]{32}"/i, "a Cloudflare account id"],
  [/\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/, "a GitHub token"],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+/, "a Slack webhook"],
  [/https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/, "a Discord webhook"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\bsk-[A-Za-z0-9]{20,}/, "an API key"],
  [/\b(?:xkeysib|xsmtpsib)-[A-Za-z0-9-]{20,}/, "an email-provider API key"],
];
const problems = [];
for (const f of files) {
  if (forbiddenFiles.some((re) => re.test(f))) problems.push(`${f}: local config or secret file must not be committed`);
  if (f === "scripts/check-secrets.mjs") continue;
  let text;
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  for (const [re, what] of patterns) if (re.test(text)) problems.push(`${f}: looks like ${what}`);
}
if (problems.length) {
  console.error("Secret check failed:\n" + problems.map((p) => "  - " + p).join("\n"));
  process.exit(1);
}
console.log(`Secret check passed (${files.length} files).`);
