import { defineConfig, devices } from "@playwright/test";

// Concurrency tests for the bible-editor. See docs/concurrency-testing-plan.md.
//
// One worker, no test-level parallelism — every test in this suite shares the
// seeded ZEC fixture and races multiple browserContexts inside the same test.
// Running tests *themselves* in parallel would cross the streams.
export default defineConfig({
  testDir: "tests/concurrency",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  globalSetup: "./tests/concurrency/global-setup.ts",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
    video: "off",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Poll the API through Vite's proxy — proves BOTH servers (Vite + Wrangler)
  // are up before tests start. Polling a bare `/` would clear once Vite is
  // alive even if Wrangler is still booting, which then 502s the first
  // /api/auth/dev call.
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173/api/health",
    reuseExistingServer: true,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
