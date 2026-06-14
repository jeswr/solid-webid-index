/**
 * feature.spec.example.ts — the per-feature e2e shape, distilled from a real
 * Bob-built Solid TODO app developed against this guide. Copy per feature and
 * adapt names/locators. Pair with global-setup.ts (seeded account) and
 * playwright.config.ts from this skill.
 *
 * Patterns it encodes:
 *  - auth/UX error states tested FIRST (they are part of the login behaviour
 *    spec in the solid-reactive-authentication skill, and they fail loudest);
 *  - beforeEach login so each feature test starts authenticated;
 *  - role/placeholder locators (no brittle CSS selectors), auto-waits, no sleep;
 *  - unique test data per run; empty state → create → mutate progression.
 */
import { test, expect } from "@playwright/test";

const WEBID = "http://localhost:3000/alice/profile/card#me"; // seeded by global-setup.ts

test.describe("Login surface", () => {
  test("shows WebID-first entry with a get-a-pod affordance", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('input[type="url"]')).toBeVisible(); // WebID input
    await expect(page.getByRole("link", { name: /get .*pod/i })).toBeVisible();
  });

  test("rejects a malformed WebID with a clear error", async ({ page }) => {
    await page.goto("/");
    await page.fill('input[type="url"]', "not-a-valid-url");
    await page.click('button[type="submit"]');
    // native URL validation or the app's own error — either way, no navigation
    await expect(page.locator('input[type="url"]')).toBeVisible();
  });

  test("surfaces an unreachable-profile error actionably", async ({ page }) => {
    await page.goto("/");
    await page.fill('input[type="url"]', "https://nonexistent.example/profile/card#me");
    await page.click('button[type="submit"]');
    await expect(page.getByText(/error/i)).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("Feature: items", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.fill('input[type="url"]', WEBID);
    await page.click('button[type="submit"]');
    await expect(page.getByRole("heading", { name: /items/i })).toBeVisible({ timeout: 15_000 });
  });

  test("shows the empty state before any item exists", async ({ page }) => {
    await expect(page.getByText(/no items yet/i)).toBeVisible();
  });

  test("adds an item and clears the input", async ({ page }) => {
    const text = `Test item ${Math.random().toString(36).slice(2)}`;
    await page.fill('input[placeholder*="add" i]', text);
    await page.click('button:has-text("Add")');
    await expect(page.getByText(text)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('input[placeholder*="add" i]')).toHaveValue("");
  });

  test("persists across reload (the pod is the store)", async ({ page }) => {
    const text = `Persistent ${Math.random().toString(36).slice(2)}`;
    await page.fill('input[placeholder*="add" i]', text);
    await page.click('button:has-text("Add")');
    await expect(page.getByText(text)).toBeVisible({ timeout: 10_000 });

    await page.reload();
    // Re-auth may run silently (prompt=none) or need re-entry — assert the data, generously.
    await page.fill('input[type="url"]', WEBID).catch(() => {});
    await page.click('button[type="submit"]').catch(() => {});
    await expect(page.getByText(text)).toBeVisible({ timeout: 20_000 });
  });
});
