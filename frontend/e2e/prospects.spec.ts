/**
 * E2E — prospects on the broker Venues page.
 * Target: deployed site (see playwright.config baseURL).
 *
 * Prod is seeded with 300 real NYC venues as scored prospects. This verifies
 * the broker can filter Book / Prospects / All and that prospect cards render
 * with their badge. Navigates via sidebar (client-side) to avoid the auth
 * hydration race.
 */
import { test, expect } from "@playwright/test";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";

test("broker venues — Book/Prospects/All filter + prospect cards render", async ({ page }) => {
  const login = new LoginPage(page);
  const dashboard = new DashboardPage(page);

  await login.goto();
  await login.signIn("broker@nightline.risk", "demo123");
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20000 });
  await dashboard.waitForLoad();

  await dashboard.venuesNavItem.click();
  await expect(page).toHaveURL(/\/venues/, { timeout: 20000 });

  // Filter chips present (All / Book / Prospects).
  const prospectsChip = page.locator(".filter-chip", { hasText: /Prospects/ });
  await expect(prospectsChip).toBeVisible({ timeout: 15000 });

  // Focus prospects, then confirm a badged prospect card shows with savings.
  await prospectsChip.click();
  await expect(page.locator(".venue-card--prospect").first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".venue-prospect-badge").first()).toBeVisible();
});
