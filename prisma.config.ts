import { defineConfig } from "prisma/config";
import { databaseUrl } from "./src/prisma/database-url.js";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: databaseUrl() },
});
