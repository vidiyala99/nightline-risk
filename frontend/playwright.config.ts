import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: 1,
  reporter: [
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["junit", { outputFile: "playwright-results.xml" }],
    ["list"],
  ],
  use: {
    // Production alias auto-follows the latest main deploy (a per-deployment
    // `*-<hash>.vercel.app` URL is immutable and silently fossilizes the suite
    // against an old build). Override with E2E_BASE_URL to pin a preview.
    baseURL: process.env.E2E_BASE_URL ?? "https://nightline-app.vercel.app",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "on-first-retry",
    // Live site — give it breathing room
    actionTimeout: 15000,
    navigationTimeout: 30000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
