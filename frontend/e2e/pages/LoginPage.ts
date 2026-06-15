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

    // Tabs in the migrated (Paper & Ink / ds) login: semantic role="tab".
    this.signInTab = page.getByRole("tab", { name: /sign in/i });
    this.createAccountTab = page.getByRole("tab", { name: /create account/i });

    // Email input rendered by the Input component — label text "Email"
    this.emailInput = page.locator('input[type="email"]');
    this.passwordInput = page.locator('input[type="password"]');
    this.nameInput = page.locator('input[placeholder="Your name"]');

    this.submitButton = page.locator('button[type="submit"]');

    // The inline role="alert" div rendered inside the form when state.error is
    // set. Scoped to the form so it can't collide with a toast alert.
    this.errorBanner = page.locator('form [role="alert"]');
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
