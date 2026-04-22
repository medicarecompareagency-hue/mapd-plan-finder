// scripts/prisma-client.js
// Shared Prisma client factory for CLI scripts.
//
// Wraps PrismaClient with the `?pgbouncer=true` connection string flag,
// required when running scripts against Supabase's transaction pooler
// (aws-1-*.pooler.supabase.com). Without this flag, Prisma uses named
// prepared statements (s0, s1, ...) that collide across pooler-reused
// backend connections, producing Postgres error 42P05:
//   "prepared statement 's0' already exists"
//
// Reading Prisma docs (https://pris.ly/d/pgbouncer), the fix is to append
// `?pgbouncer=true` to the DATABASE_URL for any client that connects
// through a transaction pooler.

const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

function readDatabaseUrl() {
  // Prisma Client normally auto-loads .env when required, but be defensive:
  // if DATABASE_URL isn't set, parse the repo's .env file directly.
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const envPath = path.join(__dirname, "..", ".env");
  try {
    const envContent = fs.readFileSync(envPath, "utf8");
    // Match a line like  DATABASE_URL=postgres://...  (optionally quoted)
    const match = envContent.match(/^\s*DATABASE_URL\s*=\s*["']?([^"'\n\r]+)["']?\s*$/m);
    if (match) return match[1];
  } catch (_e) { /* fall through */ }
  throw new Error("DATABASE_URL not found in process.env or .env file.");
}

function withPgbouncerFlag(url) {
  if (/[?&]pgbouncer=true\b/.test(url)) return url;
  return url + (url.includes("?") ? "&" : "?") + "pgbouncer=true";
}

function makePrisma() {
  const url = withPgbouncerFlag(readDatabaseUrl());
  return new PrismaClient({ datasources: { db: { url } } });
}

module.exports = { makePrisma };
