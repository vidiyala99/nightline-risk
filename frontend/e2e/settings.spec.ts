/**
 * E2E tests — Settings (profile update + password change)
 *
 * SKIPPED until the new self-service auth endpoints ship to the Railway
 * backend that this suite targets:
 *   PATCH /api/auth/me
 *   POST  /api/auth/me/change-password
 * Once deployed, remove the `.skip` on the describe block below.
 *
 * Isolation: each run registers a fresh throwaway operator via the backend
 * API (the UI register handler hardcodes localhost — see auth.spec.ts), injects
 * the JWT, then drives the real Settings UI. Never touches the shared demo
 * accounts, so it can't break other specs' logins.
 */

import { test, expect, request } from "@playwright/test";

const BACKEND_URL = "https://nightline-risk-api.onrender.com";

function uniqueEmail(): string {
  return `settings+${Date.now()}@e2e.test`;
}

async function registerAndInject(page: import("@playwright/test").Page, email: string, password: string, name: string) {
  const apiCtx = await request.newContext({ baseURL: BACKEND_URL });
  const res = await apiCtx.post("/api/auth/register", {
    data: { email, password, name, role: "venue_operator" },
  });
  expect(res.ok(), `Registration failed: ${await res.text()}`).toBeTruthy();
  const { access_token } = await res.json();
  await apiCtx.dispose();

  await page.goto("/login");
  await page.waitForSelector(".lc-login__card", { timeout: 15000 });
  await page.evaluate((token: string) => localStorage.setItem("auth_token", token), access_token);
}

test.describe.skip("Settings — profile + password", () => {
  test("editing the name persists across reload", async ({ page }) => {
    const email = uniqueEmail();
    await registerAndInject(page, email, "testpass123", "Original Name");

    await page.goto("/settings");
    const nameInput = page.locator("#profile-name");
    await expect(nameInput).toBeVisible({ timeout: 15000 });

    await nameInput.fill("Renamed Operator");
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(page.getByRole("button", { name: /Saved/ })).toBeVisible({ timeout: 15000 });

    await page.reload();
    await expect(page.locator("#profile-name")).toHaveValue("Renamed Operator", { timeout: 15000 });
  });

  test("changing the password lets you sign in with the new one", async ({ page }) => {
    const email = uniqueEmail();
    await registerAndInject(page, email, "testpass123", "Pw Tester");

    await page.goto("/settings");
    await page.locator(".settings-tab", { hasText: "Security" }).click();

    await page.locator("#old-pw").fill("testpass123");
    await page.locator("#new-pw").fill("newpass456");
    await page.locator("#confirm-pw").fill("newpass456");
    await page.getByRole("button", { name: "Change Password" }).click();
    await expect(page.getByRole("button", { name: /Updated/ })).toBeVisible({ timeout: 15000 });

    // Sign out, then sign in with the new password.
    await page.getByRole("button", { name: "Sign Out" }).first().click();
    await expect(page).toHaveURL(/\/login/, { timeout: 15000 });

    await page.locator(".lc-login__tab", { hasText: /sign in/i }).click();
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill("newpass456");
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 20000 });
  });
});
