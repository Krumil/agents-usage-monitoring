import { expect, test } from "@playwright/test";

import { createOtlpMetricsFixture } from "./fixtures.js";

test("should update the dashboard when metrics are posted", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Claude Code usage" })).toBeVisible();

  const response = await request.post("http://127.0.0.1:4328/v1/metrics", {
    data: createOtlpMetricsFixture()
  });
  expect(response.ok()).toBe(true);

  const totals = page.getByLabel("Usage totals");
  await expect(totals.getByText("$0.0375")).toBeVisible();
  await expect(totals.getByText("2K")).toBeVisible();
  await expect(page.getByText("claude-sonnet-4-6")).toBeVisible();
});
