/**
 * E2E tests — Venues page and Broker portfolio
 * Target: https://frontend-mu-ebon-n3x8uw2rpx.vercel.app
 *
 * Auth note: the app uses localStorage JWTs. Once logged in within a browser
 * context the token persists, but navigating via page.goto() causes a full
 * React re-mount which briefly shows the loading spinner before auth resolves.
 * For authenticated pages we navigate via sidebar links so the React tree is
 * already hydrated and the redirect guard doesn't fire prematurely.
 */

import { test, expect } from "@playwright/test";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { VenuesPage } from "./pages/VenuesPage";

// ─── 6. Operator venues page ──────────────────────────────────────────────────

test("operator venues page — Elsewhere Brooklyn visible, Add Venue button present", async ({ page }) => {
  const loginPage = new LoginPage(page);
  const dashboardPage = new DashboardPage(page);
  const venuesPage = new VenuesPage(page);

  // 1. Login
  await loginPage.goto();
  await loginPage.signIn("venue@elsewhere.com", "demo123");

  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20000 });
  await dashboardPage.waitForLoad();

  // 2. Navigate via sidebar (keeps React hydrated — avoids redirect guard race)
  await dashboardPage.venuesNavItem.click();

  // 3. Wait for the venues page heading
  await expect(venuesPage.heading).toBeVisible({ timeout: 20000 });

  // 4. The demo venue should appear
  await expect(venuesPage.venueCardByName("Elsewhere Brooklyn")).toBeVisible({ timeout: 15000 });

  // 5. "Add Venue" primary button is present
  await expect(venuesPage.addVenueButton).toBeVisible();
});

// ─── 7. Broker portfolio grid ─────────────────────────────────────────────────

test("broker dashboard — multiple venue portfolio cards visible in a grid", async ({ page }) => {
  const loginPage = new LoginPage(page);
  const dashboardPage = new DashboardPage(page);

  await loginPage.goto();
  await loginPage.signIn("broker@nightline.risk", "demo123");

  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20000 });
  await dashboardPage.waitForLoad();

  // The broker triage console header ("The Book") should be visible
  await expect(dashboardPage.portfolioGrid).toBeVisible({ timeout: 15000 });

  // There should be more than one venue row in the triage list. Each row is
  // now an anchor (a.lc-triage__row) that navigates straight to the venue's
  // risk profile — consistent on desktop and mobile (no hidden preview pane).
  const venueRows = page.locator(".lc-triage__row");
  const count = await venueRows.count();
  expect(count).toBeGreaterThan(1);

  // The row links to /risk-profile/<id> so tapping it works on mobile too.
  await expect(venueRows.first()).toHaveAttribute("href", /\/risk-profile\//);
});
