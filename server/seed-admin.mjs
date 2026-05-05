#!/usr/bin/env node
// Create or update the admin user. Run on the server (or anywhere with DB_PATH set).
//
// Usage:
//   node server/seed-admin.mjs <email> <password>
//   ADMIN_EMAIL=... ADMIN_PASSWORD=... node server/seed-admin.mjs
//
// On the production server:
//   sudo DB_PATH=/var/www/odyn-aware/data/odyn.db node server/seed-admin.mjs you@example.com 'somepassword'

import { openDb, upsertUser, getUserByEmail } from "./db.mjs";
import { hashPassword } from "./auth.mjs";

const email = (process.argv[2] ?? process.env.ADMIN_EMAIL ?? "").trim();
const password = process.argv[3] ?? process.env.ADMIN_PASSWORD ?? "";

if (!email || !password) {
  console.error("usage: node server/seed-admin.mjs <email> <password>");
  process.exit(2);
}
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error(`error: '${email}' is not a valid email`);
  process.exit(2);
}
if (password.length < 8) {
  console.error("error: password must be at least 8 characters");
  process.exit(2);
}

const db = openDb();
const before = getUserByEmail(db, email);
const hash = hashPassword(password);
const result = upsertUser(db, { email, password_hash: hash, role: "admin" });

console.log(
  before
    ? `[seed-admin] updated existing user '${email}' → role=admin, password reset.`
    : `[seed-admin] created admin user '${email}' (id=${result.id}).`,
);
console.log(`[seed-admin] DB: ${process.env.DB_PATH ?? "(default)"}`);
process.exit(0);
