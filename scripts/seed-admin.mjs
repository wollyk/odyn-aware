#!/usr/bin/env node
// Local one-shot: SSH to the server and run server/seed-admin.mjs as the kamal user with sudo.
//
// Usage:
//   npm run seed-admin -- <email> <password>
//
// The script:
//   1. SSHes into the prod box.
//   2. Runs `sudo node server/seed-admin.mjs <email> <password>` against /var/www/odyn-aware/current.
//   3. Reports created/updated.
//
// Requires the same DEPLOY_* env config as scripts/deploy.mjs (defaults match prod).

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const cfg = {
  user: process.env.DEPLOY_USER ?? "kamal",
  host: process.env.DEPLOY_HOST ?? "173.230.68.75",
  port: process.env.DEPLOY_PORT ?? "21",
  pw: process.env.DEPLOY_PW ?? "escevator",
};

const [, , emailArg, ...rest] = process.argv;
const passwordArg = rest.join(" ");
if (!emailArg || !passwordArg) {
  console.error("usage: npm run seed-admin -- <email> <password>");
  process.exit(2);
}

// Single-quote-escape for bash: ' -> '"'"'
function bashSingle(s) {
  return `'${String(s).replace(/'/g, `'"'"'`)}'`;
}

const remote = [
  "set -e",
  "cd /var/www/odyn-aware/current",
  `echo ${cfg.pw} | sudo -S -p '' env DB_PATH=/var/www/odyn-aware/data/odyn.db node server/seed-admin.mjs ${bashSingle(emailArg)} ${bashSingle(passwordArg)}`,
].join(" && ");

const candidates = [
  "C:\\Program Files\\PuTTY\\plink.exe",
  "C:\\Program Files (x86)\\PuTTY\\plink.exe",
];
const plink = candidates.find((c) => existsSync(c));

const proc = plink
  ? spawnSync(plink, ["-ssh", "-batch", "-P", cfg.port, "-pw", cfg.pw, `${cfg.user}@${cfg.host}`, remote], { stdio: "inherit" })
  : spawnSync("ssh", ["-p", cfg.port, `${cfg.user}@${cfg.host}`, remote], { stdio: "inherit" });

process.exit(proc.status ?? 0);
