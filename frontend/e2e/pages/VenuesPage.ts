import { Page, Locator, expect } from "@playwright/test";

export class VenuesPage {
  readonly page: Page;

  readonly heading: Locator;
  readonly addVenueButton: Locator;
  readonly venuesGrid: Locator;

  constructor(page: Page) {
    this.page = page;

    this.heading = page.locator("h1", { hasText: "Venues" });
    // Stable data-testid seams (were .btn.btn-primary / .venues-grid CSS pins).
    this.addVenueButton = page.getByTestId("add-venue");
    this.venuesGrid = page.getByTestId("venues-grid");
  }

  async goto() {
    await this.page.goto("/venues");
    await expect(this.heading).toBeVisible({ timeout: 20000 });
  }

  venueCardByName(name: string): Locator {
    return this.page.getByTestId("venue-card").filter({ hasText: name });
  }
}
