import { Page, Locator, expect } from "@playwright/test";

export class DashboardPage {
  readonly page: Page;

  // The main headings differ by role
  readonly operatorHeading: Locator;
  readonly brokerHeading: Locator;

  // Venue-operator empty state CTA
  readonly setupVenueCta: Locator;

  // Broker portfolio cards container
  readonly portfolioGrid: Locator;

  // Sidebar nav items
  readonly dashboardNavItem: Locator;
  readonly venuesNavItem: Locator;
  readonly workQueueNavItem: Locator;

  constructor(page: Page) {
    this.page = page;

    // Operator h1: "Your shift, defended by evidence."
    this.operatorHeading = page.locator("h1", { hasText: /your shift|defended/i });
    // Broker h1: "The room is louder than the model."
    this.brokerHeading = page.locator("h1", { hasText: /louder|the model/i });

    // The empty-state card links to /venues and contains "Set up your venue"
    this.setupVenueCta = page.locator("h2", { hasText: /set up.*your venue/i });

    // Broker dashboard is a triage console — "The Book" header carries a stable
    // data-testid seam (was pinned to the .lc-triage__title CSS class).
    this.portfolioGrid = page.getByTestId("dashboard-book");

    // Sidebar nav keyed by route via the SidebarNavItem data-testid seam
    // (nav-<route-slug>), so design migrations / label copy changes can't break
    // navigation the way the old .sidebar-nav-item + label-text match did.
    this.dashboardNavItem = page.getByTestId("nav-dashboard");
    this.venuesNavItem = page.getByTestId("nav-venues");
    this.workQueueNavItem = page.getByTestId("nav-work-queue");
  }

  async waitForLoad() {
    // Wait until the spinner disappears — page-loading div removed from DOM
    await this.page.waitForSelector(".page-loading", { state: "detached", timeout: 20000 });
  }

  async goto() {
    await this.page.goto("/dashboard");
  }

  async isOnDashboard() {
    await expect(this.page).toHaveURL(/\/dashboard/);
  }
}
