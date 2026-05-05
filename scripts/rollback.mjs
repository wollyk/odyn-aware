#!/usr/bin/env node
// Rollback the production AuroraView deployment.
//
// Usage:
//   npm run rollback                    # revert to the SHA before the most recent change
//   npm run rollback -- <sha>           # revert to a specific commit (any prefix >=7 chars)
//   npm run rollback -- list            # show recent deploy/rollback history
//
// Reads/appends to /var/www/odyn-aware/deploy-log.jsonl on the server.
// The DB is not touched by rollback. Schema changes are additive (CREATE TABLE IF NOT EXISTS),
// so reverting code to a pre-migration commit leaves any new tables sitting unused — no data loss.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const cfg = {
  user: process.env.DEPLOY_USER ?? "kamal",
  host: process.env.DEPLOY_HOST ?? "173.230.68.75",
  port: process.env.DEPLOY_PORT ?? "21",
  pw: process.env.DEPLOY_PW ?? "escevator",
  branch: process.env.DEPLOY_BRANCH ?? "deploy/vps-static-and-api",
  publicUrl: process.env.DEPLOY_PUBLIC_URL ?? "https://auroraview.tech",
};

function log(stage, msg = "") {
  process.stdout.write(`\n\x1b[36m[rollback] ${stage}\x1b[0m ${msg}\n`);
}
function die(msg, code = 1) {
  process.stderr.write(`\n\x1b[31m[rollback] FAILED\x1b[0m ${msg}\n`);
  process.exit(code);
}

function findPlink() {
  if (process.env.PLINK && existsSync(process.env.PLINK)) return process.env.PLINK;
  for (const c of [
    "C:\\Program Files\\PuTTY\\plink.exe",
    "C:\\Program Files (x86)\\PuTTY\\plink.exe",
  ]) {
    if (existsSync(c)) return c;
  }
  return null;
}

function ssh(remoteCmd, opts = {}) {
  const plink = findPlink();
  if (plink) {
    return spawnSync(
      plink,
      ["-ssh", "-batch", "-P", cfg.port, "-pw", cfg.pw, `${cfg.user}@${cfg.host}`, remoteCmd],
      { stdio: opts.inherit ? "inherit" : "pipe", encoding: "utf8" },
    );
  }
  return spawnSync("ssh", ["-p", cfg.port, `${cfg.user}@${cfg.host}`, remoteCmd], {
    stdio: opts.inherit ? "inherit" : "pipe",
    encoding: "utf8",
  });
}

const arg = (process.argv[2] ?? "").trim();
const isList = arg === "list" || arg === "--list" || arg === "-l";
const isShaArg = /^[a-f0-9]{7,40}$/i.test(arg);

// ---------- list mode ------------------------------------------------------
if (isList) {
  const r = ssh("cat /var/www/odyn-aware/deploy-log.jsonl 2>/dev/null || true");
  const text = (r.stdout ?? "").trim();
  if (!text) {
    process.stdout.write("(no deploy history yet)\n");
    process.exit(0);
  }
  const lines = text.split("\n").filter(Boolean);
  const last = lines.slice(-15);
  process.stdout.write(
    "\nRecent deploy history (oldest -> newest, * = current):\n\n",
  );
  for (let i = 0; i < last.length; i++) {
    let e;
    try {
      e = JSON.parse(last[i]);
    } catch {
      continue;
    }
    const marker = i === last.length - 1 ? "*" : " ";
    const ts = (e.ts ?? "").replace("T", " ").replace("Z", " UTC");
    const action = (e.action ?? "?").padEnd(8);
    const prev = (e.prev ?? "").slice(0, 8);
    const head = (e.head ?? "").slice(0, 8);
    process.stdout.write(`${marker} ${ts}  ${action}  ${prev} -> ${head}  ${e.msg ?? ""}\n`);
  }
  process.stdout.write(
    "\nRevert to one step back:           npm run rollback\n" +
      "Revert to a specific commit:       npm run rollback -- <sha>\n",
  );
  process.exit(0);
}

// ---------- determine target SHA ------------------------------------------
let targetSha = null;
let reason = "";

if (isShaArg) {
  targetSha = arg.toLowerCase();
  reason = `explicit SHA ${targetSha.slice(0, 8)}`;
} else if (arg && !isShaArg) {
  die(`Unrecognized argument: '${arg}'\nUsage: npm run rollback [-- <sha> | list]`);
} else {
  log("1/4", "looking up previous SHA from deploy log");
  const r = ssh("tail -n 1 /var/www/odyn-aware/deploy-log.jsonl 2>/dev/null || true");
  const last = (r.stdout ?? "").trim();
  if (!last) {
    die(
      "No deploy history found.\n  Run an explicit rollback: npm run rollback -- <sha>\n  Find recent SHAs with:    git log --oneline",
    );
  }
  let entry;
  try {
    entry = JSON.parse(last);
  } catch {
    die(`Could not parse last deploy log entry: ${last}`);
  }
  if (!entry.prev || !/^[a-f0-9]{7,40}$/i.test(entry.prev)) {
    die(`Latest log entry has no usable 'prev' SHA. entry=${last}`);
  }
  targetSha = entry.prev;
  reason = `the SHA before the last ${entry.action ?? "change"} (was ${entry.head?.slice(0, 8) ?? "?"})`;
  process.stdout.write(`    target: ${targetSha.slice(0, 8)} (${reason})\n`);
}

if (!targetSha) die("Could not determine target SHA.");

// ---------- perform rollback ----------------------------------------------
log("2/4", `rolling production back to ${targetSha.slice(0, 8)}`);
const remoteScript = [
  "set -e",
  "cd /var/www/odyn-aware/current",
  "PREV_SHA=$(git rev-parse HEAD)",
  "echo \"-- prev HEAD --\"; echo $PREV_SHA",
  // Bring in older history if we don't have it yet, plus latest from origin.
  "git fetch --unshallow 2>/dev/null || true",
  "git fetch --all --tags",
  `git checkout ${targetSha}`,
  "NEW_SHA=$(git rev-parse HEAD)",
  "NEW_MSG=$(git --no-pager log -1 --pretty='%s' | sed 's/\"/\\\\\"/g')",
  "echo \"-- HEAD --\"; git --no-pager log -1 --pretty='%h %s'",
  "echo \"-- npm ci --\"; npm ci --no-audit --no-fund --silent",
  "echo \"-- build --\"; npm run build 2>&1 | tail -10",
  `echo "-- restart --"; echo ${cfg.pw} | sudo -S -p '' systemctl restart odyn-api && systemctl --no-pager --lines=0 status odyn-api | head -4`,
  "TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "LOG=/var/www/odyn-aware/deploy-log.jsonl",
  "touch $LOG",
  "echo \"{\\\"ts\\\":\\\"$TS\\\",\\\"action\\\":\\\"rollback\\\",\\\"prev\\\":\\\"$PREV_SHA\\\",\\\"head\\\":\\\"$NEW_SHA\\\",\\\"msg\\\":\\\"$NEW_MSG\\\"}\" >> $LOG",
  "echo \"-- log entry --\"; tail -1 $LOG",
].join("; ");

const r = ssh(remoteScript, { inherit: true });
if (r.status !== 0) die("rollback step failed (server reported error). Site may be in a partially-rolled-back state — check `npm run rollback -- list`.");

// ---------- confirm remote HEAD --------------------------------------------
log("3/4", "verify remote HEAD");
const headOut = ssh("cd /var/www/odyn-aware/current && git rev-parse HEAD").stdout.trim();
if (!headOut.startsWith(targetSha) && targetSha.length >= 7 && !targetSha.startsWith(headOut.slice(0, targetSha.length))) {
  die(`HEAD mismatch.\n  expected: ${targetSha}\n  got:      ${headOut}`);
}
process.stdout.write(`    remote HEAD ${headOut.slice(0, 8)} OK\n`);

// ---------- smoke-test public URL ------------------------------------------
log("4/4", "smoke-test public URL");
let attempts = 4;
let ok = false;
while (attempts-- > 0) {
  try {
    const homeRes = await fetch(cfg.publicUrl + "/", { cache: "no-store" });
    const apiRes = await fetch(cfg.publicUrl + "/api/health", { cache: "no-store" });
    const apiText = (await apiRes.text()).trim();
    process.stdout.write(`    GET /          ${homeRes.status}\n`);
    process.stdout.write(`    GET /api/health ${apiRes.status}  ${apiText}\n`);
    if (homeRes.status === 200 && apiRes.status === 200 && apiText.includes("ok")) {
      ok = true;
      break;
    }
  } catch (e) {
    process.stdout.write(`    attempt failed: ${e.message}\n`);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
if (!ok) {
  process.stdout.write(
    "\n\x1b[33m[rollback] WARN public smoke-test did not confirm cleanly. Try a hard refresh (Ctrl+F5).\x1b[0m\n",
  );
}
log("done", `${cfg.publicUrl} now serves ${headOut.slice(0, 8)}`);
process.stdout.write("    to roll forward again: npm run deploy   (push your fix or just redeploy main)\n");
