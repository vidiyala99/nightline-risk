/**
 * E2E — broker bind flow. The bind action used to fire a native `window.prompt`
 * for the carrier policy number, which Playwright can't drive (it lives outside
 * the page DOM) — so this flow had ZERO coverage. It's now an in-app PromptDialog,
 * which makes it assertable with ordinary `getByRole`.
 *
 * Non-mutating by design: we open the dialog and Cancel (binding would consume
 * the shared demo submission). Tolerant-empty: skips if the demo book has no
 * bindable quote (e.g. already bound). Target: deployed site.
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

test("broker bind opens an in-app dialog (not a native window.prompt)", async ({ page }) => {
  await loginBroker(page);
  await page.goto("/submissions/sub-demo-quoting");
  await expect(page).toHaveURL(/\/submissions\//, { timeout: 20000 });

  const bind = page.getByRole("button", { name: /^bind/i }).first();
  if (!(await bind.isVisible({ timeout: 15000 }).catch(() => false))) {
    test.skip(true, "No bindable quote in the demo book (already bound) — tolerant skip.");
    return;
  }

  await bind.click();

  // The fix: an in-DOM modal, not OS chrome — assertable.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 10000 });
  await expect(dialog.getByRole("heading", { name: /bind policy/i })).toBeVisible();
  await expect(dialog.getByLabel(/carrier-issued policy number/i)).toBeVisible();

  // Cancel — non-mutating (don't bind/consume the shared demo submission).
  await dialog.getByRole("button", { name: /cancel/i }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
