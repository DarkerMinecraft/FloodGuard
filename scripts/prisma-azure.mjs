// Runs a Prisma CLI command against Azure Database for PostgreSQL with Entra ID auth:
// gets an access token for the signed-in identity (`az login` locally) and passes it
// as the password in DATABASE_URL. Reads PGHOST / PGDATABASE / PGUSER from .env.local.
//
//   node scripts/prisma-azure.mjs migrate deploy
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { DefaultAzureCredential } from "@azure/identity";

for (const file of [".env.local", ".env"]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

const { PGHOST, PGDATABASE = "floodguard", PGUSER } = process.env;
if (!PGHOST || !PGUSER) {
  console.error("Set PGHOST and PGUSER (see .env.example).");
  process.exit(1);
}

const { token } = await new DefaultAzureCredential().getToken("https://ossrdbms-aad.database.windows.net/.default");
const url = `postgresql://${encodeURIComponent(PGUSER)}:${encodeURIComponent(token)}@${PGHOST}:5432/${PGDATABASE}?sslmode=require`;

const result = spawnSync("npx", ["prisma", ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, DATABASE_URL: url },
});
process.exit(result.status ?? 1);
