// Several client companies, each with its own entitled applications (example names only).
import { test, expect } from "@playwright/test";

const companies: [string, string[]][] = [
  [
    "Endeavour Group",
    ["Oracle Responsys", "Oracle Unity Customer Data Platform"],
  ],
  [
    "Dan Murphy's",
    [
      "Oracle Responsys",
      "Oracle Eloqua",
      "Oracle Unity Customer Data Platform",
      "Oracle Infinity",
    ],
  ],
];

test("each client company sees only its own applications", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel("Work email").fill("consultant@example.test");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  // The provider creates each company with its subscribed tools.
  for (const [i, [name, apps]] of companies.entries()) {
    if (i === 1)
      await page.getByRole("button", { name: "Provider console" }).click();
    await page.getByLabel("Company name").fill(name);
    for (const a of apps) await page.getByLabel(a, { exact: true }).check();
    await page
      .getByRole("button", { name: "Create company", exact: true })
      .click();
    if (i === 0)
      await expect(
        page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ }),
      ).toBeVisible();
    else await expect(page.getByText(`Companies (${i + 1})`)).toBeVisible();
  }
  await page.screenshot({
    path: "test-results/provider-console.png",
    fullPage: true,
  });
  for (const [name, apps] of companies) {
    await page.getByLabel("Workspace").selectOption({ label: name });
    await expect(page.locator(".portal .eyebrow")).toHaveText(
      name.toUpperCase(),
    );
    const options = await page
      .getByLabel("Select your application")
      .locator("option")
      .allTextContents();
    expect(options.slice(1)).toEqual(apps);
  }
  // A company administrator sees the subscription but cannot change it.
  await page.getByRole("button", { name: "Workspace settings" }).click();
  await expect(page.getByLabel("Your subscription")).toContainText(
    "Oracle Eloqua: subscribed",
  );
  await expect(page.getByLabel("Your subscription")).toContainText(
    "To add or remove a tool, contact your platform provider.",
  );
  // A company sign-in link opens that company directly after verification.
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto("/?company=endeavour-group");
  await expect(
    page.getByRole("heading", { name: "Sign in to Endeavour Group" }),
  ).toBeVisible();
  await page.getByLabel("Work email").fill("consultant@example.test");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.locator(".portal .eyebrow").first()).toHaveText(
    "ENDEAVOUR GROUP",
  );
});

test("a client template brings the logo, rules and documentation links", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel("Work email").fill("consultant@example.test");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  // A provider without companies lands on the first-company form; otherwise open the console.
  const template = page.getByLabel("Client template");
  const consoleButton = page.getByRole("button", { name: "Provider console" });
  await expect(template.or(consoleButton)).toBeVisible();
  if (!(await template.isVisible())) await consoleButton.click();
  await page
    .getByLabel("Client template")
    .selectOption({ label: "Endeavour Group" });
  await expect(page.getByLabel("Company name")).toHaveValue("Endeavour Group");
  await page.getByLabel("Company name").fill("Endeavour Group (template)");
  await page.getByLabel("Company address").fill("edg-template");
  for (const a of ["Oracle Eloqua", "Oracle Infinity"])
    await page.getByLabel(a, { exact: true }).check();
  await page
    .getByRole("button", { name: "Create company", exact: true })
    .click();
  await expect(page.getByText("Companies (3)")).toBeVisible();
  await page
    .getByLabel("Workspace")
    .selectOption({ label: "Endeavour Group (template)" });
  await expect(
    page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ }),
  ).toBeVisible();
  // Only the Endeavour logo, in the header; no client panel on the home page.
  const header = page.getByRole("button", { name: "Company home" });
  await expect(
    header.getByRole("img", { name: "Endeavour Group logo" }),
  ).toHaveAttribute("src", "/brand/endeavour-group-white.svg");
  await expect(header.getByRole("img")).toHaveCount(1);
  await expect(
    page.getByRole("region", { name: "Client profile" }),
  ).toHaveCount(0);
  // Inside an application: the official Oracle documentation is one click away.
  await page
    .getByLabel("Select your application")
    .selectOption({ label: "Oracle Eloqua" });
  await page.getByRole("button", { name: "Open application" }).click();
  await expect(page.getByRole("link", { name: /Oracle docs/ })).toHaveAttribute(
    "href",
    "https://docs.oracle.com/en/cloud/saas/marketing/eloqua-user/",
  );
});
