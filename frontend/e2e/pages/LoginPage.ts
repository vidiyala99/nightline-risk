import { Page, Locator, expect } from "@playwright/test";

export class LoginPage {
  readonly page: Page;

  // Tab controls
  readonly signInTab: Locator;
  readonly createAccountTab: Locator;

  // Form fields
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly nameInput: Locator;
  readonly submitButton: Locator;

  // Inline error banner
  readonly errorBanner: Locator;

  constructor(page: Page) {
    this.page = page;

    // Tabs in the redesigned centered-card login. Text is "01 / Sign in" / "02 / Create account".
    this.signInTab = page.locator(".lc-login__tab", { hasText: /sign in/i });
    this.createAccountTab = page.locator(".lc-login__tab", { hasText: /create account/i });

    // Email input rendered by the Input component — label text "Email"
    this.emailInput = page.locator('input[type="email"]');
    this.passwordInput = page.locator('input[type="password"]');
    this.nameInput = page.locator('input[placeholder="Your name"]');

    this.submitButton = page.locator('button[type="submit"]');

    // The .lc-login__error div rendered when state.error is set
    this.errorBanner = page.locator(".lc-login__error");
  }

  async goto() {
    await this.page.goto("/login");
    await expect(this.signInTab).toBeVisible();
  }

  async signIn(email: string, password: string) {
    await this.signInTab.click();
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }

  async switchToCreateAccount() {
    await this.createAccountTab.click();
  }

  // Public sign-up always creates a venue operator (no role picker; backend
  // ignores any client-supplied role — escalation guard).
  async register(name: string, email: string, password: string) {
    await this.switchToCreateAccount();
    await this.nameInput.fill(name);
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }
}
