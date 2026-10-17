import { defineConfig } from "prisma/config";

// The server only accepts Entra ID tokens, so there's no fixed connection string:
// `scripts/prisma-azure.mjs` builds DATABASE_URL with a fresh token for CLI commands
// (migrate, studio). The app itself connects through lib/db.ts.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL ?? "" },
});
