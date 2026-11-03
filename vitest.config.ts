import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            APP_ORIGIN: "https://survey.test",
            ENTRA_TENANT_ID: "tenant-test",
            ENTRA_CLIENT_ID: "client-test",
            ENTRA_CLIENT_SECRET: "secret-test",
            ENTRA_ADMIN_GROUP_ID: "group-admin",
            ADMIN_EMAILS: "boss@chromavis.com",
            OTP_PEPPER: "pepper-test",
            TURNSTILE_SECRET_KEY: "turnstile-test",
            EMAIL_PROVIDER: "memory"
          }
        }
      })
    ],
    test: { setupFiles: ["./tests/setup.ts"] }
  };
});
