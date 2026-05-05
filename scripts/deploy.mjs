#!/usr/bin/env node
// One-command deploy: commit (if dirty), push, SSH server, pull+build+restart, smoke-test prod.
//
// Usage:
//   npm run deploy
//   npm run deploy -- "your commit message"
//
// Configuration via env (override defaults if needed):
//   DEPLOY_USER=kamal
//   DEPLOY_HOST=173.230.68.75
//   DEPLOY_PORT=21
//   DEPLOY_PW=escevator        (sudo + ssh password)
//   DEPLOY_BRANCH=deploy/vps-static-and-api
//   DEPLOY_PUBLIC_URL=https://auroraview.tech
//   PLINK=C:\Program Files\PuTTY\plink.exe   (Windows; auto-detected if not set)

import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const cfg = {
  user: process.env.DEPLOY_USER ?? "kamal",
  host: process.env.DEPLOY_HOST ?? "173.230.68.75",
  port: process.env.DEPLOY_PORT ?? "21",
  pw: process.env.DEPLOY_PW ?? "escevator",
  branch: process.env.DEPLOY_BRANCH ?? "deploy/vps-static-and-api",
  publicUrl: process.env.DEPLOY_PUBLIC_URL ?? "https://auroraview.tech",
};
const commitMsgArg = process.argv.slice(2).join(" ").trim();

function log(stage, msg = "") {
  process.stdout.write(`\n\x1b[36m[deploy] ${stage}\x1b[0m ${msg}\n`);
}
function die(msg, code = 1) {
  process.stderr.write(`\n\x1b[31m[deploy] FAILED\x1b[0m ${msg}\n`);
  process.exit(code);
}

function git(args) {
  return execSync(`git ${args}`, { encoding: "utf8" }).trim();
}

function findPlink() {
  if (process.env.PLINK && existsSync(process.env.PLINK)) return process.env.PLINK;
  const candidates = [
    "C:\\Program Files\\PuTTY\\plink.exe",
    "C:\\Program Files (x86)\\PuTTY\\plink.exe",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

function sshExec(remoteCmd, opts = {}) {
  const plink = findPlink();
  if (plink) {
    const args = ["-ssh", "-batch", "-P", cfg.port, "-pw", cfg.pw, `${cfg.user}@${cfg.host}`, remoteCmd];
    return spawnSync(plink, args, { stdio: opts.inherit ? "inherit" : "pipe", encoding: "utf8" });
  }
  // Fallback: assume keys + standard ssh
  return spawnSync("ssh", ["-p", cfg.port, `${cfg.user}@${cfg.host}`, remoteCmd], {
    stdio: opts.inherit ? "inherit" : "pipe",
    encoding: "utf8",
  });
}

(async function run() {
  // 1. Ensure we are on the deploy branch
  log("1/6", "checking git branch");
  const currentBranch = git("rev-parse --abbrev-ref HEAD");
  if (currentBranch !== cfg.branch) {
    die(`Expected branch '${cfg.branch}', currently on '${currentBranch}'.\nRun: git checkout ${cfg.branch}`);
  }

  // 2. Commit any pending changes
  log("2/6", "git commit (if needed)");
  const status = git("status --porcelain");
  if (status) {
    const message = commitMsgArg || `deploy: ${new Date().toISOString().replace(/[:.]/g, "-")}`;
    execSync("git add -A", { stdio: "inherit" });
    execSync(`git commit -m ${JSON.stringify(message)}`, { stdio: "inherit" });
  } else {
    process.stdout.write("    nothing to commit\n");
  }

  // 3. Push
  log("3/6", "git push");
  execSync(`git push origin ${cfg.branch}`, { stdio: "inherit" });
  const localHead = git("rev-parse HEAD");
  process.stdout.write(`    pushed ${localHead.slice(0, 8)}\n`);

  // 4. Remote pull + build + restart
  log("4/6", "remote pull, build, restart");
  const remoteScript = [
    "set -e",
    "cd /var/www/odyn-aware/current",
    `git fetch --depth=1 origin ${cfg.branch}`,
    `git checkout -B ${cfg.branch} origin/${cfg.branch}`,
    "echo \"-- HEAD --\"; git --no-pager log -1 --pretty='%h %s'",
    "echo \"-- npm ci --\"; npm ci --no-audit --no-fund --silent",
    "echo \"-- build --\"; npm run build 2>&1 | tail -10",
    `echo "-- restart --"; echo ${cfg.pw} | sudo -S -p '' systemctl restart odyn-api && systemctl --no-pager --lines=0 status odyn-api | head -4`,
  ].join("; ");
  const r = sshExec(remoteScript, { inherit: true });
  if (r.status !== 0) die("remote deploy step failed");

  // 5. Verify remote HEAD == local HEAD
  log("5/6", "verify remote HEAD == local HEAD");
  const remoteHead = sshExec("cd /var/www/odyn-aware/current && git rev-parse HEAD").stdout.trim();
  if (remoteHead !== localHead) {
    die(`HEAD mismatch.\n  local:  ${localHead}\n  remote: ${remoteHead}`);
  }
  process.stdout.write(`    remote HEAD ${remoteHead.slice(0, 8)} OK\n`);

  // 6. Smoke-test public URL
  log("6/6", "smoke-test public URL");
  let attempts = 4;
  let ok = false;
  while (attempts-- > 0) {
    try {
      const headRes = await fetch(cfg.publicUrl + "/", { cache: "no-store" });
      const body = await headRes.text();
      const titleMatch = body.match(/<title>([^<]*)<\/title>/i);
      const apiRes = await fetch(cfg.publicUrl + "/api/health", { cache: "no-store" });
      const apiText = (await apiRes.text()).trim();
      const homeOk = headRes.status === 200;
      const apiOk = apiRes.status === 200 && apiText.includes("ok");
      process.stdout.write(`    GET /          ${headRes.status}  title: ${titleMatch ? titleMatch[1] : "(none)"}\n`);
      process.stdout.write(`    GET /api/health ${apiRes.status}  ${apiText}\n`);
      if (homeOk && apiOk) { ok = true; break; }
    } catch (e) {
      process.stdout.write(`    attempt failed: ${e.message}\n`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!ok) {
    process.stdout.write("\n\x1b[33m[deploy] WARN public smoke-test did not confirm cleanly. Build is on the server though; try a hard refresh in your browser (Ctrl+F5).\x1b[0m\n");
  }
  log("done", `${cfg.publicUrl} now serves ${localHead.slice(0, 8)}`);
})().catch((e) => die(e?.stack ?? String(e)));
