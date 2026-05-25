/**
 * E2E — broker money-path surfaces added since May 10: Tasks feed, Policy
 * Requests queue, and Claims. Verifies each is reachable from the sidebar and
 * renders its page header. Target: deployed site.
 */
import { test, expect } from "@playwright/test";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";

async function loginBroker(page: any) {
  const login = new LoginPage(page);
  const dashboard = new DashboardPage(page);
  await login.goto();
  await login.signIn("broker@thirdspace.risk", "demo123");
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20000 });
  await dashboard.waitForLoad();
}

function navItem(page: any, label: string) {
  return page.locator(".sidebar-nav-item", { hasText: new RegExp(`^${label}$`) });
}

test("broker tasks feed — reachable from sidebar, renders", async ({ page }) => {
  await loginBroker(page);
  await navItem(page, "Tasks").click();
  await expect(page).toHaveURL(/\/tasks/, { timeout: 20000 });
  await expect(page.locator(".page-header__title", { hasText: /Tasks/i })).toBeVisible({ timeout: 15000 });
});

test("broker policy-requests queue — reachable, renders", async ({ page }) => {
  await loginBroker(page);
  await navItem(page, "Requests").click();
  await expect(page).toHaveURL(/\/policy-requests/, { timeout: 20000 });
  await expect(page.locator(".page-header__title", { hasText: /Policy requests/i })).toBeVisible({ timeout: 15000 });
});

test("broker claims — reachable, renders", async ({ page }) => {
  await loginBroker(page);
  await navItem(page, "Claims").click();
  await expect(page).toHaveURL(/\/claims/, { timeout: 20000 });
  // Claims list page renders (header or an empty-state — either is a pass).
  await expect(page.locator("h1, .page-header__title").first()).toBeVisible({ timeout: 15000 });
});
