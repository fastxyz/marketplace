import { expect, test } from "@playwright/test";

test("marketplace browsing, suggestion submit, admin review, and skill markdown", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Data APIs for agents" })).toBeVisible();
  await expect(page.getByText("Mock Research Signals")).toBeVisible();

  await page.getByRole("link", { name: /Mock Research Signals/i }).click();
  await expect(page.getByRole("heading", { name: "Mock Research Signals" })).toBeVisible();
  await expect(page.getByText("Available Endpoints (2)")).toBeVisible();

  await page.goto("/suggest?service=mock-research-signals&type=endpoint");
  await page.getByLabel("Title").fill("Add a ranked signal watchlist endpoint");
  await page
    .getByLabel("Description")
    .fill("Create a watchlist-friendly endpoint that returns the top paid signals with compact metadata.");
  await page.getByLabel("Email").fill("builder@example.com");
  await page.getByRole("button", { name: "Submit suggestion" }).click();
  await expect(page.getByText("Suggestion submitted. Providers and operators can now review it privately.")).toBeVisible();

  await page.goto("/admin/login");
  await page.getByLabel("Admin token").fill("test-admin-token");
  await page.getByRole("button", { name: "Open admin queue" }).click();
  await expect(page.getByRole("heading", { name: "Suggestion queue" })).toBeVisible();
  await expect(page.getByText("Add a ranked signal watchlist endpoint")).toBeVisible();

  await page.locator('select[name="status"]').first().selectOption("reviewing");
  await page.getByRole("button", { name: "Save" }).first().click();
  await page.goto("/admin/suggestions?status=reviewing");
  await expect(page.getByText("Add a ranked signal watchlist endpoint")).toBeVisible();

  await page.goto("/skill.md");
  await expect(page.locator("body")).toContainText("# Fast Marketplace");
});
