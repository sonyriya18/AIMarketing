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

test("a client template brings logos, websites, rules and documentation links", async ({
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
    .selectOption({ label: "Endeavour Group – Dan Murphy's" });
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
  const panel = page.getByRole("region", { name: "Client profile" });
  await expect(
    panel.getByRole("heading", { name: "Endeavour Group – Dan Murphy's" }),
  ).toBeVisible();
  await expect(panel.getByRole("img", { name: /logo/ }).first()).toBeVisible();
  await expect(
    panel.getByRole("link", { name: /Dan Murphy's website/ }),
  ).toHaveAttribute("href", "https://www.danmurphys.com.au/dm/home");
  await expect(panel).toContainText("ABAC");
  // Only the subscribed applications are listed, each with its Oracle documentation.
  await expect(panel).toContainText("Oracle Eloqua");
  await expect(panel).not.toContainText("Oracle Unity Customer Data Platform");
  await expect(
    panel.getByRole("link", { name: "Eloqua user guide" }),
  ).toHaveAttribute("href", /^https:\/\/docs\.oracle\.com\//);
  // Inside an application the client context and rules stay visible.
  await page
    .getByLabel("Select your application")
    .selectOption({ label: "Oracle Eloqua" });
  await page.getByRole("button", { name: "Open application" }).click();
  await expect(page.locator(".client-strip")).toContainText("Liquor retail");
});
