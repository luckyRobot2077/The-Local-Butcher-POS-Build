import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
/** Dev server with a fake Supabase URL; the cloud test intercepts every call to it. */
const CLOUD_PORT = PORT + 1;

/**
 * End-to-end tests. The offline tests run against a production build
 * (`npm run build` first) because the service worker is only registered in
 * production. The cloud test runs against `next dev` with fake Supabase
 * settings (dev uses its own .next/dev folder, so the two do not clash).
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    serviceWorkers: "allow",
  },
  projects: [
    {
      name: "tablet",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
      grepInvert: /@phone/,
      testIgnore: /cloud-sync/,
    },
    { name: "phone", use: { ...devices["Pixel 7"] }, grep: /@phone/, testIgnore: /cloud-sync/ },
    {
      name: "cloud",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        baseURL: `http://localhost:${CLOUD_PORT}`,
      },
      testMatch: /cloud-sync/,
    },
  ],
  webServer: [
    {
      command: `npx next start -p ${PORT}`,
      url: `http://localhost:${PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `npx next dev -p ${CLOUD_PORT}`,
      url: `http://localhost:${CLOUD_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { NEXT_PUBLIC_SUPABASE_URL: "http://supabase.fake.test", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fake-anon-key" },
    },
  ],
});
