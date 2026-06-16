/**
 * E2E — broker money-path surfaces: Tasks feed, Policy Requests queue, and
 * Claims. Requests + Claims are reachable from the sidebar; Tasks is no longer
 * a primary sidebar destination after the per-persona IA nav spine (the page
 * still exists and is verified by direct navigation). Target: deployed site.
 */
import { test, expect } from "@playwright/test";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";

async function loginBroker(page: any) {
  const login = new LoginPage(page);
  const dashboard = new DashboardPage(page);
  await login.goto();
  await login.signIn("broker@nightline.risk", "demo123");
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20000 });
  await dashboard.waitForLoad();
}

function navItem(page: any, label: string) {
  return page.locator(".sidebar-nav-item", { hasText: new RegExp(`^${label}$`) });
}

test("broker tasks page — renders via direct nav (not in the IA sidebar spine)", async ({ page }) => {
  await loginBroker(page);
  await page.goto("/tasks");
  await expect(page).toHaveURL(/\/tasks/, { timeout: 20000 });
  // Migrated to Paper & Ink: semantic heading hook (dropped the legacy .page-header__title class).
  await expect(page.getByRole("heading", { name: /Tasks/i })).toBeVisible({ timeout: 15000 });
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
