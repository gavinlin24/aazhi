import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    }),
  ],
  test: {
    // discord-api-types ships CommonJS with thin .mjs wrappers, which the
    // Workers test pool cannot load; pre-bundling turns it into plain ESM.
    deps: { optimizer: { ssr: { enabled: true, include: ["discord-api-types/v10"] } } },
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
