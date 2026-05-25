/**
 * E2E — operator "My Coverage" surface (the operator side of the operator↔
 * broker loop). Verifies the operator can reach Coverage from the sidebar and
 * it renders. Target: deployed site.
 */
import { test, expect } from "@playwright/test";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";

test("operator coverage page — reachable from sidebar, renders", async ({ page }) => {
  const login = new LoginPage(page);
  const dashboard = new DashboardPage(page);

  await login.goto();
  await login.signIn("venue@elsewhere.com", "demo123");
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20000 });
  await dashboard.waitForLoad();

  await page.locator(".sidebar-nav-item", { hasText: /^Coverage$/ }).click();
  await expect(page).toHaveURL(/\/coverage/, { timeout: 20000 });
  await expect(page.locator(".page-header__title", { hasText: /coverage/i })).toBeVisible({ timeout: 15000 });
});
