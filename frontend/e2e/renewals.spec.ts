/**
 * E2E tests — Renewals page
 * Target: https://frontend-mu-ebon-n3x8uw2rpx.vercel.app
 * Backend API: https://thirdspacerisk-production.up.railway.app
 *
 * Journey: broker logs in → visits /renewals → asserts due-list heading →
 * if a Renew button is present, clicks it and asserts the YoY result panel.
 *
 * The test is intentionally tolerant of an empty due-list: when no policies
 * are expiring within 60 days against the demo backend the Renew branch is
 * skipped and the test still passes (heading-only assertion).
 */

import { test, expect } from "@playwright/test";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";

// ─── 8. Renewals due-list ─────────────────────────────────────────────────────

test("broker renewals page — Renewals due heading visible", async ({ page }) => {
  const loginPage = new LoginPage(page);
  const dashboardPage = new DashboardPage(page);

  // 1. Log in as broker
  await loginPage.goto();
  await loginPage.signIn("broker@thirdspace.risk", "demo123");

  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20000 });
  await dashboardPage.waitForLoad();

  // 2. Navigate to /renewals via window.location so the JWT is already in
  //    localStorage (same technique used by auth.spec.ts test 5 to avoid the
  //    redirect guard race on full page.goto navigations).
  await page.evaluate(() => { window.location.href = "/renewals"; });

  // 3. Wait for the page heading to appear
  const heading = page.getByRole("heading", { name: /renewals due/i });
  await expect(heading).toBeVisible({ timeout: 20000 });
});

// ─── 9. Renewals — Renew action + YoY panel ──────────────────────────────────

test("broker renewals — Renew button triggers YoY result panel (skips if empty)", async ({ page }) => {
  const loginPage = new LoginPage(page);
  const dashboardPage = new DashboardPage(page);

  // 1. Log in as broker
  await loginPage.goto();
  await loginPage.signIn("broker@thirdspace.risk", "demo123");

  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20000 });
  await dashboardPage.waitForLoad();

  // 2. Navigate to /renewals
  await page.evaluate(() => { window.location.href = "/renewals"; });

  const heading = page.getByRole("heading", { name: /renewals due/i });
  await expect(heading).toBeVisible({ timeout: 20000 });

  // 3. Wait briefly for the due-list data fetch to resolve
  await page.waitForTimeout(3000);

  // 4. Check whether any Renew button is present (empty book → test still passes)
  const renewButton = page.getByRole("button", { name: "Renew" }).first();
  const isPresent = await renewButton.isVisible().catch(() => false);

  if (!isPresent) {
    // Empty due-list is valid — assert the empty-state message and skip the
    // renew branch so the test doesn't hard-fail against a clean demo dataset.
    const emptyMsg = page.locator(".policies-empty");
    await expect(emptyMsg).toBeVisible({ timeout: 5000 });
    return;
  }

  // 5. Click Renew and wait for the YoY result panel
  await renewButton.click();

  // The panel carries role="status" and contains a badge with text
  // "Renewal submitted" (rendered by .renewals-yoy-panel__badge).
  const yoyPanel = page.locator('[role="status"]', { hasText: /renewal submitted/i });
  await expect(yoyPanel).toBeVisible({ timeout: 20000 });

  // The YoY table with the aria-label is also present
  const yoyTable = page.getByRole("table", { name: /year-over-year context/i });
  await expect(yoyTable).toBeVisible();
});
