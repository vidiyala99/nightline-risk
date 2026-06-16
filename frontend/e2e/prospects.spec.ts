/**
 * E2E — Venues is book-only; prospects live on /market.
 *
 * The /venues page is the broker's book of business (insured customers).
 * Prospects (unbound NYC nightlife licensees) live on /market — a separate
 * acquisition surface. This test pins the separation: /venues must not
 * surface the source filter or any prospect-tagged cards.
 */
import { test, expect } from "@playwright/test";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";

test("broker venues — book-only, no source filter, no prospect cards", async ({ page }) => {
  const login = new LoginPage(page);
  const dashboard = new DashboardPage(page);

  await login.goto();
  await login.signIn("broker@nightline.risk", "demo123");
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20000 });
  await dashboard.waitForLoad();

  await dashboard.venuesNavItem.click();
  await expect(page).toHaveURL(/\/venues/, { timeout: 20000 });

  // At least one venue card must render (book is seeded with operators).
  await expect(page.getByTestId("venue-card").first()).toBeVisible({ timeout: 15000 });

  // Source filter and prospect tagging are gone from /venues. The prospect badge
  // has a stable seam (it renders on risk-profile), so its absence here is a
  // meaningful leak guard. The two remaining class checks assert *removed*
  // constructs stay removed — there's no element on /venues to seam them to.
  await expect(page.locator(".filter-chip", { hasText: /Prospects/ })).toHaveCount(0);
  await expect(page.locator(".venue-card--prospect")).toHaveCount(0);
  await expect(page.getByTestId("venue-prospect-badge")).toHaveCount(0);
});
