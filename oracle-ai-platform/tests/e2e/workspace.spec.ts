// Browser journeys for each new application (B1) plus access, empty-state, mobile and keyboard
// checks (B2). Uploads use the clearly SYNTHETIC files in examples/.
import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

test.describe.configure({ mode: "serial" });
const errors: string[] = [];
let page: Page;
test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
});
test.afterAll(async () => {
  expect(errors).toEqual([]);
  await page.close();
});

const nav = (name: string) =>
  page
    .getByRole("navigation", { name: "Main" })
    .getByRole("button", { name, exact: true });
const FOLLOW_UP = ["Action plans", "Drafts", "Investigations", "Reports"];
// Follow-up pages sit under one "Follow-up" button, each with its own sub-tab.
const tool = (name: string) =>
  FOLLOW_UP.includes(name)
    ? {
        click: async () => {
          await page
            .getByRole("navigation", { name: "Workspace tools" })
            .getByRole("button", { name: "Follow-up", exact: true })
            .click();
          await page
            .getByRole("navigation", { name: "Follow-up" })
            .getByRole("button", { name, exact: true })
            .click();
        },
      }
    : page
        .getByRole("navigation", { name: "Workspace tools" })
        .getByRole("button", { name, exact: true });
async function openApp(name: string) {
  await page.getByRole("button", { name: "Company home" }).click();
  await page
    .getByLabel("Select your application")
    .selectOption({ label: name });
  await page
    .getByRole("button", { name: "Open application", exact: true })
    .click();
}
async function addSourceAndUpload(app: string, sourceName: string) {
  await expect(
    page.getByRole("heading", {
      name: new RegExp(`Add your first .* source account`),
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Add source account", exact: true })
    .click();
  await page.getByLabel("Source account / environment name").fill(sourceName);
  await page
    .getByRole("button", { name: "Create source account", exact: true })
    .click();
  await page.getByRole("button", { name: /Upload my exports/ }).click();
  await page.getByLabel("Source data as of").fill("2026-10-28T12:00");
  await page
    .getByLabel("Upload data file")
    .setInputFiles(resolve(`examples/${app}.json`));
  await page.getByLabel("Snapshot name").fill(`${app} synthetic snapshot`);
  await page
    .getByRole("button", { name: "Validate and preview", exact: true })
    .click();
  await page.getByRole("button", { name: /^Import \d+ records$/ }).click();
  await expect(
    page.getByText("Dataset imported. Use Load latest assessment to view it."),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Load latest assessment", exact: true })
    .click();
  await nav("Summary").click();
  await expect(
    page.getByRole("heading", { name: "Top recommendations" }),
  ).toBeVisible();
  await expect(page.getByLabel("Assessment context")).toContainText(sourceName);
}
const topic = (name: string) =>
  page.getByRole("navigation", { name: "Topics" }).getByRole("button", {
    name: new RegExp("^" + name.replace(/[&]/g, "\\$&")),
  });
async function evidenceAndAction() {
  const first = page.locator("article.finding").first();
  await first.getByText("Evidence and plan").click();
  await expect(first.getByText("Priority basis")).toBeVisible();
  await first.getByRole("button", { name: "Save plan" }).click();
  await expect(
    page.getByText(/Action plan saved with an evidence baseline/),
  ).toBeVisible();
  await topic("Data & definitions").click();
  await page.getByText("Inspect calculation").first().click();
}
async function askAI(label: string) {
  await nav(label).click();
  await page
    .getByLabel("Your question")
    .fill("What needs attention, and what evidence supports it?");
  await page.getByRole("button", { name: "Ask AI", exact: true }).click();
  await expect(
    page.getByText("Rule-based guidance (no AI)").first(),
  ).toBeVisible();
}
async function draftFromFinding() {
  await nav("Summary").click();
  await page
    .locator("article.finding")
    .first()
    .getByRole("button", { name: "Draft" })
    .click();
  await page.getByLabel("Draft title").fill("Review brief");
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(
    page.getByText(/AI not configured: rule-based prefill/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Review brief/ }),
  ).toBeVisible();
}
async function saveReport(title: string) {
  await tool("Reports").click();
  await page.getByLabel("Report title").fill(title);
  await page.getByRole("button", { name: "Save report", exact: true }).click();
  await expect(page.getByText("Report saved.")).toBeVisible();
  await expect(page.getByRole("cell", { name: title })).toBeVisible();
}

test("company setup and entitled launcher", async () => {
  await page.goto("/");
  await page.screenshot({ path: "test-results/login.png" });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel("Work email").fill("admin@example.test");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Add your first client company" }),
  ).toBeVisible();
  await page.getByLabel("Company name").fill("Example Company");
  for (const label of [
    "Oracle Responsys",
    "Oracle Eloqua",
    "Oracle Unity Customer Data Platform",
    "Oracle Infinity",
  ])
    await page.getByLabel(label, { exact: true }).check();
  await page
    .getByRole("button", { name: "Create company", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ }),
  ).toBeVisible();
  // Only the subscribed tools are offered (no extra cross-tool card).
  await expect(
    page.getByRole("button", { name: /Combined evidence/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /Oracle Responsys/ }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Responsys was not found in the platform",
  );
  await page.screenshot({ path: "test-results/portal.png", fullPage: true });
});

test("Eloqua: upload → assess → analyze → compare → simulate → Ask AI → draft/report/action → reload", async () => {
  await openApp("Oracle Eloqua");
  await addSourceAndUpload("eloqua", "Eloqua production");
  await expect(
    page.getByRole("heading", { name: "What matters in this data" }),
  ).toBeVisible();
  await expect(page.getByText("Rule-based (AI not used)")).toBeVisible();
  await page.screenshot({
    path: "test-results/eloqua-overview.png",
    fullPage: true,
  });
  await topic("Campaigns").click();
  for (const heading of [
    "Open and click rate by month",
    "Delivered emails by month and campaign",
    "Campaign performance",
  ])
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
  await expect(
    page.getByText("Review delivery: bounce rate above threshold").first(),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/eloqua-campaigns.png",
    fullPage: true,
  });
  await topic("Leads").click();
  for (const heading of [
    "New leads per month by source",
    "Lead funnel (mature leads)",
    "Leads by source",
  ])
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
  await expect(
    page
      .getByText("Follow up on marketing-qualified leads waiting for sales")
      .first(),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/eloqua-leads.png",
    fullPage: true,
  });
  await topic("Sales").click();
  await expect(
    page.getByRole("heading", {
      name: "Leads, pipeline and revenue by campaign",
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/eloqua-sales.png",
    fullPage: true,
  });
  await topic("Events").click();
  await expect(
    page.getByRole("heading", { name: "Events and webinars", exact: true }),
  ).toBeVisible();
  await topic("Website").click();
  await expect(
    page.getByRole("heading", { name: "Website landing pages", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/eloqua-website.png",
    fullPage: true,
  });
  await topic("Nurture & assets").click();
  await expect(
    page.getByRole("heading", {
      name: "Nurture structure and step progression",
    }),
  ).toBeVisible();
  // "Ask AI about this" opens Ask Eloqua AI and sends the question.
  await page.getByRole("button", { name: "Ask AI about this" }).first().click();
  await expect(nav("Ask Eloqua AI")).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".chat-turn .question").last()).toContainText(
    "what stands out",
  );
  await nav("Summary").click();
  await topic("Overview").click();
  await evidenceAndAction();
  await page.screenshot({
    path: "test-results/eloqua-summary.png",
    fullPage: true,
  });
  await nav("Analyze Campaign / Nurture").click();
  await page
    .getByLabel("Select record")
    .selectOption({ label: "Q4 nurture (synthetic)" });
  await page.getByRole("button", { name: "Assess", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Scoped assessment" }),
  ).toBeVisible();
  await expect(
    page.getByText("Nurture step loses most contacts").first(),
  ).toBeVisible();
  await nav("Compare Campaigns").click();
  await page.locator(".comparison-choices input[type=checkbox]").nth(0).check();
  await page.locator(".comparison-choices input[type=checkbox]").nth(1).check();
  await page
    .getByRole("button", { name: "Compare selected", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Comparability" }),
  ).toBeVisible();
  await expect(
    page.getByText(/No winner declared|unlikely to be chance/),
  ).toBeVisible();
  await nav("AI Simulator").click();
  await expect(page.getByLabel("Delivered emails (measured)")).not.toHaveValue(
    "",
  );
  await page.getByLabel("Assumed click rate after change (%)").fill("6");
  await page
    .getByRole("button", { name: "Calculate and save scenario" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Scenario result" }),
  ).toBeVisible();
  await expect(page.getByText(/Hypothetical projection/)).toBeVisible();
  await askAI("Ask Eloqua AI");
  await draftFromFinding();
  await saveReport("Eloqua weekly review");
  await page.reload();
  await openApp("Oracle Eloqua");
  await tool("Action plans").click();
  await expect(
    page.getByRole("heading", {
      name: /Review delivery: bounce rate above threshold/,
    }),
  ).toBeVisible();
  await tool("Drafts").click();
  await expect(
    page.getByRole("button", { name: /Review brief/ }),
  ).toBeVisible();
  await tool("Reports").click();
  await expect(
    page.getByRole("cell", { name: "Eloqua weekly review" }),
  ).toBeVisible();
  await nav("AI Simulator").click();
  await expect(
    page.locator("details summary").filter({ hasText: "eloqua-scenario-v1" }),
  ).toBeVisible();
});

test("Unity: readiness, overlap, audience draft, investigation and persistence", async () => {
  await openApp("Oracle Unity Customer Data Platform");
  await addSourceAndUpload("unity", "Unity production");
  await topic("Customers").click();
  await expect(
    page.getByRole("heading", { name: "Identity links", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/unity-customers.png",
    fullPage: true,
  });
  await topic("Audiences").click();
  await expect(
    page
      .getByRole("heading", { name: "Audience readiness", exact: true })
      .first(),
  ).toBeVisible();
  await topic("Consent").click();
  await expect(
    page.getByRole("heading", {
      name: "Consent states by channel and purpose",
    }),
  ).toBeVisible();
  await topic("Jobs").click();
  await expect(
    page.getByText(/Investigate failed job Identity resolution/),
  ).toBeVisible();
  await topic("Overview").click();
  await evidenceAndAction();
  await nav("Analyze Data / Audience").click();
  await page
    .getByLabel("Select record")
    .selectOption({ label: "Newsletter audience (synthetic)" });
  await page.getByRole("button", { name: "Assess", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /Activation blockers for/ }),
  ).toBeVisible();
  await nav("Compare Audiences").click();
  await page.getByLabel(/Newsletter audience/).check();
  await page.getByLabel(/Reactivation audience/).check();
  await page
    .getByRole("button", { name: "Compare selected", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Exact audience overlap" }),
  ).toBeVisible();
  await expect(page.getByText("|A ∩ B| / |A ∪ B| × 100")).toBeVisible();
  await nav("AI Simulator").click();
  await page
    .getByLabel("Audience (for measured readiness inputs)")
    .selectOption({ label: "Newsletter audience (synthetic)" });
  await page.getByRole("button", { name: "Load measured inputs" }).click();
  await expect(page.getByLabel("Ready members (measured)")).not.toHaveValue("");
  await page
    .getByLabel("Assumed share of missing fields completed (%)")
    .fill("50");
  await page
    .getByLabel("Assumed share of consent verified as granted (%)")
    .fill("25");
  await page
    .getByRole("button", { name: "Calculate and save scenario" })
    .click();
  await expect(page.getByText(/assumed consent is not consent/)).toBeVisible();
  await askAI("Ask Unity AI");
  await nav("Summary").click();
  await page
    .locator("article.finding")
    .first()
    .getByRole("button", { name: "Investigate" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Timeline across snapshots" }),
  ).toBeVisible();
  await page
    .getByLabel("Add a hypothesis")
    .fill("A recent feed change dropped the field");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(
    page.getByText("A recent feed change dropped the field"),
  ).toBeVisible();
  await tool("Drafts").click();
  await page
    .getByLabel("Draft type")
    .selectOption({ label: "Audience definition draft" });
  await page.getByLabel("Draft title").fill("US audience");
  await page.getByRole("button", { name: "Create draft" }).click();
  const def = page.getByLabel(
    "Typed definition (JSON, validated against this tenant's fields)",
  );
  await def.fill(
    '{"match":"all","conditions":[{"field":"country","operator":"equals","value":"US"}]}',
  );
  await page
    .getByRole("button", { name: "Validate / translate request" })
    .click();
  await expect(page.getByText(/Local preview: \d+ members/)).toBeVisible();
  await page.getByRole("button", { name: "Save revision" }).click();
  await page.reload();
  await openApp("Oracle Unity Customer Data Platform");
  await tool("Investigations").click();
  await page
    .getByRole("button", { name: /Investigate:/ })
    .first()
    .click();
  await expect(
    page.getByText("A recent feed change dropped the field"),
  ).toBeVisible();
});

test("Infinity: journey, tracking quality, cohorts, scenario and persistence", async () => {
  await openApp("Oracle Infinity");
  await addSourceAndUpload("infinity", "Infinity site");
  await topic("Tracking").click();
  await expect(
    page.getByRole("heading", { name: "Tracking quality", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Events per complete day" }),
  ).toBeVisible();
  await expect(
    page.getByText(/Repair add_to_cart: missing device/),
  ).toBeVisible();
  await topic("Website").click();
  for (const heading of [
    "Average time on page (busiest pages)",
    "Single-page (bounce) rate by landing page",
    "Website performance by page",
    "Time spent per session",
    "Engagement by device",
    "Website performance by page (saved report)",
  ])
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
  await page.screenshot({
    path: "test-results/infinity-web.png",
    fullPage: true,
  });
  await topic("Overview").click();
  await evidenceAndAction();
  await nav("Analyze Journey").click();
  await page.getByLabel("Step 1", { exact: true }).selectOption("view_product");
  await page.getByLabel("Step 2", { exact: true }).selectOption("add_to_cart");
  await page
    .getByLabel("Step 3", { exact: true })
    .selectOption("checkout_start");
  await page.getByLabel("Step 4", { exact: true }).selectOption("purchase");
  await page.getByRole("button", { name: "Run journey analysis" }).click();
  await expect(
    page.getByRole("heading", { name: "Ordered journey" }),
  ).toBeVisible();
  await page.getByText("Show as table").first().click();
  await nav("Compare Journeys / Cohorts").click();
  await page
    .getByLabel(/device: mobile/)
    .first()
    .check();
  await page
    .getByLabel(/device: desktop/)
    .first()
    .check();
  await page
    .getByRole("button", { name: "Compare selected", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Side-by-side assessment" }),
  ).toBeVisible();
  await nav("AI Simulator").click();
  await page.getByLabel("Baseline session conversion rate (%)").fill("2");
  await page.getByLabel("Assumed conversion rate after change (%)").fill("3");
  await page
    .getByRole("button", { name: "Calculate and save scenario" })
    .click();
  await expect(
    page.getByText(/Hypothetical\. Not an observed result/),
  ).toBeVisible();
  await askAI("Ask Infinity AI");
  await saveReport("Infinity review");
  await tool("Data & connections").click();
  await page.getByRole("button", { name: "Run digest now" }).click();
  await expect(page.getByText(/Digest saved:/)).toBeVisible();
  await tool("Notifications").click();
  await expect(page.getByText(/Digest: \d+ open signals/)).toBeVisible();
  await page.reload();
  await openApp("Oracle Infinity");
  await tool("Reports").click();
  await expect(
    page.getByRole("cell", { name: "Infinity review" }),
  ).toBeVisible();
});

test("AI home: attention list, briefing, work queue and ask across applications", async () => {
  await page.getByRole("button", { name: "Company home" }).click();
  await expect(
    page.getByRole("heading", { name: "What needs attention" }),
  ).toBeVisible();
  await expect(page.locator("ul.attention li").first()).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Your work queue" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Write AI briefing" }).click();
  await expect(page.getByText("Rule-based briefing (no AI)")).toBeVisible();
  await page.screenshot({ path: "test-results/home.png", fullPage: true });
  await expect(page.getByText("Rule-based briefing (no AI)")).toBeVisible();
  await expect(page.locator(".briefing li").first()).toBeVisible();
  await page
    .getByLabel("Ask across your applications")
    .fill("Which campaigns have a high bounce rate?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByLabel("Your question")).toHaveValue(
    "Which campaigns have a high bounce rate?",
    { timeout: 20000 },
  );
  await expect(nav("Ask Eloqua AI")).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "Company home" }).click();
  await page.locator("ul.attention button").first().click();
  await expect(
    page.getByRole("heading", { name: "Top recommendations" }),
  ).toBeVisible();
});

test("mobile layout and keyboard navigation", async () => {
  await openApp("Oracle Eloqua");
  await page.setViewportSize({ width: 390, height: 844 });
  await nav("Summary").click();
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: "test-results/eloqua-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await nav("Summary").focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(nav("AI Simulator")).toHaveAttribute("aria-current", "page");
});

test("a viewer sees only granted apps and cannot change data", async ({
  browser,
}) => {
  await page.getByRole("button", { name: "Company home" }).click();
  await page.getByRole("button", { name: "Workspace settings" }).click();
  await page.getByLabel("Member email").fill("viewer@example.test");
  await page.getByLabel("Role").selectOption("viewer");
  await page
    .getByRole("group", { name: "Application access for this member" })
    .getByLabel("Eloqua")
    .check();
  await page.getByRole("button", { name: "Add or update member" }).click();
  await expect(
    page.getByRole("cell", { name: "viewer@example.test" }),
  ).toBeVisible();
  const ctx = await browser.newContext();
  const v = await ctx.newPage();
  await v.goto("/");
  await v.getByRole("button", { name: "Continue", exact: true }).click();
  await v.getByLabel("Work email").fill("viewer@example.test");
  await v.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(v.getByLabel("Select your application")).toBeVisible();
  const options = await v
    .getByLabel("Select your application")
    .locator("option")
    .allTextContents();
  expect(options).toEqual(["Choose an application", "Oracle Eloqua"]);
  await v
    .getByLabel("Select your application")
    .selectOption({ label: "Oracle Eloqua" });
  await v
    .getByRole("button", { name: "Open application", exact: true })
    .click();
  await expect(
    v.getByRole("heading", { name: "Top recommendations" }),
  ).toBeVisible();
  await expect(v.getByRole("button", { name: "Save plan" })).toHaveCount(0);
  await v
    .getByRole("navigation", { name: "Workspace tools" })
    .getByRole("button", { name: "Data & connections" })
    .click();
  await expect(v.getByRole("heading", { name: "Upload exports" })).toHaveCount(
    0,
  );
  await ctx.close();
});
