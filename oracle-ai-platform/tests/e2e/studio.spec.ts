// Responsys-level screens for Eloqua, Unity and Infinity on the synthetic sample data:
// deep dive, head-to-head, flows, email builder, audience builder and customer profile.
import { test, expect, type Page } from "@playwright/test";

async function openWithSample(page: Page, product: string) {
  await page.goto("/");
  await page.locator(".product-card", { hasText: product }).first().click();
  await page
    .getByRole("button", { name: "Add source account" })
    .first()
    .click();
  await page.getByRole("button", { name: "Create source account" }).click();
  await page.getByRole("button", { name: "Load sample data" }).first().click();
  await expect(page.getByText(/Loaded \d+ sample records/)).toBeVisible({
    timeout: 20000,
  });
}
const main = (page: Page, name: RegExp) =>
  page.getByRole("navigation", { name: "Main" }).getByRole("button", { name });

test("deep dives, head-to-head, flows and builders for all three tools", async ({
  page,
}) => {
  test.setTimeout(180000);
  await page.goto("/");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel("Work email").fill("consultant@example.test");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  // Earlier tests may already have created companies: then the form is in the Provider console.
  await expect(
    page
      .getByLabel("Company name")
      .or(page.getByRole("button", { name: "Provider console" })),
  ).toBeVisible();
  if (!(await page.getByLabel("Company name").isVisible()))
    await page.getByRole("button", { name: "Provider console" }).click();
  await page.getByLabel("Company name").fill("Studio test");
  for (const a of [
    "Oracle Eloqua",
    "Oracle Unity Customer Data Platform",
    "Oracle Infinity",
  ])
    await page.getByLabel(a, { exact: true }).check();
  await page
    .getByRole("button", { name: "Create company", exact: true })
    .click();
  // Work inside the new company.
  const ws = page.getByLabel("Workspace", { exact: true });
  const previous = (await ws.isVisible()) ? await ws.inputValue() : "";
  if (previous) await ws.selectOption({ label: "Studio test" });

  // Eloqua: campaign deep dive with preview, head-to-head, email builder.
  await openWithSample(page, "Oracle Eloqua");
  await main(page, /Analyze/).click();
  await expect(page.getByText("Campaign deep dive")).toBeVisible();
  await expect(page.getByText(/Account pattern/).first()).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Campaign preview" }),
  ).toBeVisible();
  await expect(
    page
      .frameLocator('iframe[title^="Email preview"]')
      .getByText("Register now"),
  ).toBeVisible();
  await main(page, /Compare/).click();
  await expect(page.getByText("measures ahead").first()).toBeVisible();
  await page.getByRole("button", { name: "VS all" }).click();
  await expect(page.locator(".portfolio-table tbody tr")).toHaveCount(6);
  await main(page, /Email Builder/).click();
  await expect(
    page
      .frameLocator('iframe[title^="Email preview"]')
      .getByText("Save my seat"),
  ).toBeVisible();
  await page.getByLabel("Subject line").fill("Your invitation is inside");
  await expect(
    page.locator(".inbox-head .subject").getByText("Your invitation is inside"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(page.getByText(/Saved as a draft/)).toBeVisible();
  // Refine with AI: asks in your own words; without an AI key it says so and changes nothing.
  const refine = page.getByRole("region", { name: "Refine with AI" });
  await expect(refine).toBeVisible();
  await refine
    .getByLabel("What should change?")
    .fill("Make the tone friendlier");
  await refine.getByRole("button", { name: "Propose changes" }).click();
  await expect(page.getByText(/AI editing is not configured/)).toBeVisible();
  await expect(page.getByLabel("Subject line")).toHaveValue(
    "Your invitation is inside",
  );
  await page.screenshot({ path: "test-results/eloqua-refine.png" });

  // Unity: audience deep dive, audience builder, customer profile, identity flow.
  await openWithSample(page, "Oracle Unity Customer Data Platform");
  await main(page, /Analyze/).click();
  await expect(page.getByText("Audience deep dive")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Why members are or are not ready" }),
  ).toBeVisible();
  await main(page, /Audience Builder/).click();
  await page.getByRole("button", { name: "Add condition" }).click();
  await page.getByLabel("Value").fill("US");
  await expect(page.locator(".audience-result strong")).not.toHaveText("—");
  await page.getByRole("button", { name: "Customer profile" }).click();
  await page.getByLabel("Find a person").fill("M-1");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByText("Master ID M-1")).toBeVisible();
  await page.getByRole("button", { name: "Identity flow" }).click();
  await expect(
    page.getByRole("img", { name: /Identity: source systems/ }),
  ).toBeVisible();

  // Infinity: page deep dive with path flow, journey flow.
  await openWithSample(page, "Oracle Infinity");
  await main(page, /Analyze/).click();
  await expect(page.getByText("Page deep dive")).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Where visitors came from and went next",
    }),
  ).toBeVisible();
  await main(page, /Journey Flow/).click();
  await expect(
    page.getByRole("heading", { name: "Visitor journeys: first three pages" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/journey-flow.png",
    fullPage: true,
  });
  // Leave the user in the company the other tests use.
  if (previous)
    await page.getByLabel("Workspace", { exact: true }).selectOption(previous);
});
