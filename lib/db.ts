import "server-only";

import { DefaultAzureCredential } from "@azure/identity";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { Prisma, PrismaClient } from "@/lib/generated/prisma/client";

// Azure Database for PostgreSQL with Entra ID auth only (password auth is disabled on
// the server): the "password" is a short-lived access token for the signed-in identity.
// Locally that's your `az login`; in Azure, a managed identity added as a database role.
// Prisma talks to it through a pg Pool so each new connection gets a current token.
// The schema lives in prisma/schema.prisma; apply migrations with `npm run db:migrate`.
const TOKEN_SCOPE = "https://ossrdbms-aad.database.windows.net/.default";

export const dbConfigured = Boolean(process.env.PGHOST);

// One client per server process (and across dev hot reloads).
const globalForDb = globalThis as unknown as { floodguardDb?: PrismaClient };

function createClient(): PrismaClient {
  if (!dbConfigured) throw new Error("PGHOST is not set");
  const credential = new DefaultAzureCredential();
  const pool = new Pool({
    host: process.env.PGHOST,
    database: process.env.PGDATABASE ?? "floodguard",
    user: process.env.PGUSER,
    // Called for each new connection; the SDK caches the token until it nears expiry.
    password: async () => (await credential.getToken(TOKEN_SCOPE)).token,
    ssl: { rejectUnauthorized: true },
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });
  pool.on("error", (err) => console.error("Postgres pool error", err));
  return new PrismaClient({ adapter: new PrismaPg(pool) });
}

/** The Prisma client; throws when the database isn't configured (check `dbConfigured`). */
export function db(): PrismaClient {
  return (globalForDb.floodguardDb ??= createClient());
}

/** True for a unique-constraint violation (e.g. a duplicate place name). */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}
