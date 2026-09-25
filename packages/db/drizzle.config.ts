import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://gigpilot:gigpilot@127.0.0.1:4715/gigpilot",
  },
  strict: true,
  verbose: false,
});
