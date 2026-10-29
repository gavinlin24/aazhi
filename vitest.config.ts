import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

// Two projects: nearly everything runs inside workerd, as the Worker does,
// and test/node holds the few checks workerd cannot run, like compiling the
// page script from its string.
export default defineConfig({
  test: {
    projects: [
      {
        extends: false,
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
          }),
        ],
        test: {
          name: "workers",
          exclude: [...configDefaults.exclude, "test/node/**"],
          // discord-api-types ships CommonJS with thin .mjs wrappers, which the
          // Workers test pool cannot load; pre-bundling turns it into plain ESM.
          deps: { optimizer: { ssr: { enabled: true, include: ["discord-api-types/v10"] } } },
          setupFiles: ["./test/apply-migrations.ts"],
        },
      },
      {
        extends: false,
        test: {
          name: "node",
          include: ["test/node/**/*.test.ts"],
          environment: "node",
        },
      },
    ],
  },
});
