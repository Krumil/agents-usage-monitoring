import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test",
  testMatch: "**/*.e2e.ts",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:6173",
    trace: "on-first-retry"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ],
  webServer: {
    command: "pnpm dev:e2e",
    url: "http://127.0.0.1:6173",
    reuseExistingServer: false,
    timeout: 120_000
  }
});
