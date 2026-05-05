#!/usr/bin/env node
// View early-access submissions from the production SQLite DB.
//   npm run submissions          # last 50 rows
//   npm run submissions -- 200   # last 200
//   npm run submissions -- json  # JSON output

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const cfg = {
  user: process.env.DEPLOY_USER ?? "kamal",
  host: process.env.DEPLOY_HOST ?? "173.230.68.75",
  port: process.env.DEPLOY_PORT ?? "21",
  pw: process.env.DEPLOY_PW ?? "escevator",
};

const arg = (process.argv[2] || "50").trim();
const wantJson = arg === "json";
const limit = Number.isFinite(Number(arg)) ? Math.min(Math.max(Number(arg), 1), 5000) : 50;

const sql = wantJson
  ? `SELECT json_group_array(json_object('id',id,'created_at',created_at,'name',name,'email',email,'company',company,'environment',environment,'message',message,'ip',ip)) FROM (SELECT * FROM early_access ORDER BY id DESC LIMIT 1000)`
  : `SELECT id, datetime(created_at) AS submitted, name, email, company, environment, ip FROM early_access ORDER BY id DESC LIMIT ${limit}`;

const remote = wantJson
  ? `echo ${cfg.pw} | sudo -S -p '' sqlite3 /var/www/odyn-aware/data/odyn.db ${JSON.stringify(sql)}`
  : `echo ${cfg.pw} | sudo -S -p '' sqlite3 -column -header /var/www/odyn-aware/data/odyn.db ${JSON.stringify(sql)}`;

const candidates = [
  "C:\\Program Files\\PuTTY\\plink.exe",
  "C:\\Program Files (x86)\\PuTTY\\plink.exe",
];
const plink = candidates.find((c) => existsSync(c));
const proc = plink
  ? spawnSync(plink, ["-ssh", "-batch", "-P", cfg.port, "-pw", cfg.pw, `${cfg.user}@${cfg.host}`, remote], { stdio: "inherit" })
  : spawnSync("ssh", ["-p", cfg.port, `${cfg.user}@${cfg.host}`, remote], { stdio: "inherit" });

process.exit(proc.status ?? 0);
