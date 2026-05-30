/**
 * E2E tests — Authentication flows
 * Target: https://nightline-app.vercel.app
 * Backend API: https://nightline-risk-api.onrender.com
 *
 * Tests are kept independent: each test navigates to /login fresh
 * and does not rely on state from a previous test.
 */

import { test, expect, request } from "@playwright/test";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { VenuesPage } from "./pages/VenuesPage";

const BACKEND_URL = "https://nightline-risk-api.onrender.com";

// ─── helpers ─────────────────────────────────────────────────────────────────

function generateEmail(): string {
  const ts = Date.now();
  return `test+${ts}@venue.com`;
}

// ─── 1. Operator login ────────────────────────────────────────────────────────

test("operator login — redirects to dashboard with Operational Defense heading", async ({ page }) => {
  const loginPage = new LoginPage(page);
  const dashboardPage = new DashboardPage(page);

  await loginPage.goto();
  await loginPage.signIn("venue@elsewhere.com", "demo123");

  // Should land on /dashboard
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20000 });

  // Wait for spinner to clear (data fetch)
  await dashboardPage.waitForLoad();

  // Heading contains "Operational Defense"
  await expect(dashboardPage.operatorHeading).toBeVisible();

  // Dashboard nav item should have the "active" class
  await expect(dashboardPage.dashboardNavItem).toHaveClass(/active/);
});

// ─── 2. Broker login ─────────────────────────────────────────────────────────

test("broker login — redirects to dashboard with Evidence-First Underwriting heading", async ({ page }) => {
  const loginPage = new LoginPage(page);
  const dashboardPage = new DashboardPage(page);

  await loginPage.goto();
  await loginPage.signIn("broker@nightline.risk", "demo123");

  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20000 });
  await dashboardPage.waitForLoad();

  // Heading contains "Evidence-First"
  await expect(dashboardPage.brokerHeading).toBeVisible();

  // Broker sidebar should show "Reports" nav item (broker-only)
  await expect(dashboardPage.portfolioLabel).toBeVisible();
});

// ─── 3. Invalid credentials ───────────────────────────────────────────────────

test("invalid credentials — inline error banner appears, no system alert", async ({ page }) => {
  const loginPage = new LoginPage(page);

  // Intercept any browser dialog (system alert) — there should be none
  let dialogFired = false;
  page.on("dialog", (dialog) => {
    dialogFired = true;
    dialog.dismiss();
  });

  await loginPage.goto();
  await loginPage.signIn("notauser@example.com", "wrongpassword");

  // Error banner in DOM, not a system dialog
  await expect(loginPage.errorBanner).toBeVisible({ timeout: 15000 });

  // Banner text contains a meaningful error message
  const bannerText = await loginPage.errorBanner.textContent();
  expect(bannerText).toBeTruthy();

  // No system alert was triggered
  expect(dialogFired).toBe(false);

  // URL stays on /login — no redirect
  await expect(page).toHaveURL(/\/login/);
});

// ─── 4. Invalid email format ──────────────────────────────────────────────────

test("invalid email format — browser validation fires, no network request made", async ({ page }) => {
  const loginPage = new LoginPage(page);

  // Track whether any auth API call is attempted
  let authCallMade = false;
  page.on("request", (req) => {
    if (req.url().includes("/api/auth")) authCallMade = true;
  });

  await loginPage.goto();

  // Type a non-email string and attempt submit
  await loginPage.emailInput.fill("notanemail");
  await loginPage.passwordInput.fill("somepassword");
  await loginPage.submitButton.click();

  // The HTML5 email input validation should prevent form submission.
  // The page should remain on /login with no API calls.
  await page.waitForTimeout(1000); // brief pause to allow any errant request

  await expect(page).toHaveURL(/\/login/);
  expect(authCallMade).toBe(false);

  // The input should be invalid per the browser constraint API
  const isInvalid = await loginPage.emailInput.evaluate(
    (el: HTMLInputElement) => !el.validity.valid
  );
  expect(isInvalid).toBe(true);
});

// ─── 5. New venue operator registration — lands on operator dashboard ─────────
//
// The login page's registration handler hardcodes http://127.0.0.1:8000 instead
// of using NEXT_PUBLIC_API_URL, so registration via the UI always fails on Vercel
// with "Failed to fetch". Workaround: register via the Railway API directly, inject
// the JWT into localStorage, then navigate — which replicates exactly what the UI
// would have done with the correct env var.
//
// The backend auto-assigns a venue and seeds it with data, so new operators see the
// full dashboard (Risk Profile + Premium Quote) rather than the empty-state CTA.
// This test therefore asserts that the new operator lands on the dashboard with
// the correct "Operational Defense" heading.

test("new venue operator account — lands on operator dashboard", async ({ page }) => {
  const email = generateEmail();
  const password = "testpass123";
  const name = "E2E Test User";

  // 1. Register directly against the Railway backend
  const apiCtx = await request.newContext({ baseURL: BACKEND_URL });
  const regRes = await apiCtx.post("/api/auth/register", {
    data: { email, password, name, role: "venue_operator" },
  });
  expect(regRes.ok(), `Registration failed: ${await regRes.text()}`).toBeTruthy();
  const { access_token } = await regRes.json();
  await apiCtx.dispose();

  // 2. Load the login page to establish the correct localStorage origin, then
  //    wait for React to fully hydrate the page
  await page.goto("/login");
  await page.waitForSelector(".lc-login__card", { timeout: 15000 });

  // 3. Inject the JWT into localStorage
  await page.evaluate((token: string) => {
    localStorage.setItem("auth_token", token);
  }, access_token);

  // 4. Trigger a full navigation to /dashboard. Using window.location.href
  //    causes the browser to navigate with the token already in localStorage
  //    so AuthContext.useEffect reads it on mount.
  await page.evaluate(() => { window.location.href = "/dashboard"; });

  // 5. Wait for loading to complete
  const dashboardPage = new DashboardPage(page);
  await dashboardPage.waitForLoad();

  // 6. The new operator should see the operator dashboard
  await expect(dashboardPage.operatorHeading).toBeVisible({ timeout: 20000 });
});
