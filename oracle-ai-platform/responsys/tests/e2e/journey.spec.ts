/**
 * End-to-end journey in a real browser through the original five pages:
 * sign in → empty workspace → account → upload a file on Summary → exact figures → evidence →
 * Save Report → Analyze Campaign → Compare (VS 2, VS Multiple) → AI Simulator (save scenario,
 * create campaign draft) → Ask AI. Uses the synthetic golden fixture only.
 */
import { expect, test } from '@playwright/test';

const shot = (name: string) => `test-results/screens/${name}.png`;

test('login account selection controls the header logo and remains outside report pages', async ({ page }) => {
  const email = `login-brand-${Date.now()}@example.test`;
  await page.goto('/');
  await expect(page.getByLabel('Account', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: shot('account-login'), fullPage: true });
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Workspace name').fill('Account entry workspace');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByLabel('Account', { exact: true }).selectOption('business:amil_dental');
  await page.getByRole('button', { name: 'Continue to application' }).click();
  const brand = page.getByTestId('account-brand');
  await expect(page.getByRole('img', { name: 'Amil logo', exact: true })).toBeVisible();
  await expect.poll(async () => page.getByRole('img', { name: 'Amil logo', exact: true }).evaluate((img) => (img as unknown as { naturalWidth: number }).naturalWidth)).toBeGreaterThan(0);
  const amilId = await brand.getAttribute('data-account-id');
  for (const tab of ['briefing', 'simulator', 'analyse', 'battlecard', 'chat']) {
    await page.locator(`#tab-${tab}`).click();
    await expect(page.getByLabel('Account', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Official business website')).toHaveCount(0);
    await expect(page.getByRole('img', { name: 'Amil logo', exact: true })).toBeVisible();
  }
  await page.reload();
  await expect(brand).toHaveAttribute('data-account-id', amilId!);
  await page.locator('header').screenshot({ path: shot('account-header') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(brand).toBeVisible();
  const bounds = await brand.boundingBox();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.locator('header').screenshot({ path: shot('account-header-mobile') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await brand.click();
  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  await page.getByLabel('Account name').fill('Private software account');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(brand).toHaveAttribute('aria-label', 'Change account (Private software account)');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('Account', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('option', { name: 'Private software account' })).toHaveCount(0);
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Choose your account' })).toBeVisible();
  await page.getByLabel('Account', { exact: true }).selectOption(amilId!);
  await page.getByRole('button', { name: 'Continue to application' }).click();
  await expect(brand).toHaveAttribute('data-account-id', amilId!);
  await expect(page.getByRole('img', { name: 'Amil logo', exact: true })).toBeVisible();
});

test('launch hours change estimates using real imported timing history', async ({ page }) => {
  const dentalWebsiteSmoke = process.env.E2E_DENTAL_WEBSITE === 'true';
  await page.goto('/');
  await page.getByLabel('Email').fill(`timed-${Date.now()}@example.test`);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Workspace name').fill('Timed campaigns');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByLabel('Account', { exact: true }).selectOption('other');
  await page.getByLabel('Account name').fill(dentalWebsiteSmoke ? 'Amil' : 'Timing account');
  await page.getByLabel('Account timezone (IANA)').fill('America/Sao_Paulo');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByTestId('account-brand')).toBeVisible();
  const accountId = await page.getByTestId('account-brand').getAttribute('data-account-id');
  const session = (await (await page.request.get('/api/v1/session')).json()).data;
  const headers = { 'x-csrf-token': session.csrfToken, Origin: new URL(page.url()).origin };
  const csv = ['Campaign ID,Launch Date,Launch Time,Channel,Sent,Delivered,Unique Opens,Unique Clicks,Conversions,Orders,Revenue',
    ...[5, 12, 19].flatMap((day, i) => [
      `M${i},2026-10-${String(day).padStart(2, '0')},09:15,Email,1000,1000,300,30,10,10,100`,
      `A${i},2026-10-${String(day).padStart(2, '0')},15:30,Email,1000,1000,500,50,10,10,100`,
    ])].join('\n');
  const upload = await page.request.post(`/api/v1/accounts/${accountId}/imports`, { headers, multipart: { file: { name: 'timed.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) } } });
  expect(upload.status()).toBe(201);
  const imp = (await upload.json()).data;
  const validation = await page.request.post(`/api/v1/imports/${imp.id}/validate`, { headers, data: { mapping: { ...imp.detection.proposal, timezoneConfirmed: true, datasetName: 'Timed history', coverageStart: '2026-10-01', coverageEnd: '2026-10-20' } } });
  expect((await validation.json()).data.ok).toBe(true);
  expect((await page.request.post(`/api/v1/imports/${imp.id}/commit`, { headers })).status()).toBe(202);
  await expect.poll(async () => (await (await page.request.get(`/api/v1/imports/${imp.id}`)).json()).data.status).toBe('completed');
  if (dentalWebsiteSmoke) await page.route('**/reports/*/summary', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.data?.businessContext?.status === 'ready') body.data.businessContext.offers = [
      { id: 'synthetic-offer', title: 'Synthetic test offer', text: 'Up to 20% discount on selected items. Participating locations only.', audience: 'unspecified', checkedAt: new Date().toISOString(), sourceUrl: 'https://dental.example.test/offers', landingUrl: 'https://dental.example.test/offers' },
      { id: 'synthetic-member', title: 'Synthetic member offer', text: 'Members only: special conditions for existing members.', audience: 'members', checkedAt: new Date().toISOString(), sourceUrl: 'https://dental.example.test/members', landingUrl: 'https://dental.example.test/members' },
    ];
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await page.locator('#tab-simulator').click();
  if (dentalWebsiteSmoke) {
    const strategies = page.locator('#wi-strategy');
    await expect(strategies.getByText(/^(Dentist Network Discovery|Dental Plan Discovery)$/).first()).toBeVisible({ timeout: 30_000 });
    await expect(strategies.getByText('Dental Plan Enrollment', { exact: true }).first()).toBeVisible();
    await expect(strategies.getByText('New Dental Member Welcome', { exact: true }).first()).toBeVisible();
    await expect(strategies.getByText('Cart Recovery', { exact: true })).toHaveCount(0);
    await expect(page.locator('#business-strategy-source')).toContainText('Website-informed dental strategies');
    await strategies.screenshot({ path: shot('dental-business-strategies') });
    await page.locator('[data-strategy="engagement"]').click();
    const campaigns = page.locator('#wi-campaigns');
    await expect(campaigns.locator('[data-journey-campaign]')).toHaveCount(2);
    await expect(campaigns.getByText('CONTACTS_LIST.EMAIL_PERMISSION_STATUS_', { exact: true }).first()).toBeVisible();
    await expect(campaigns.getByText('PET_DENTAL_LEAD.LEAD_STATUS', { exact: true })).toBeVisible();
    await expect(campaigns.getByText('Exclusion conditions', { exact: true })).toHaveCount(0);
    await expect(campaigns.getByText('PET_MARKETING_CONTROL.SUPPRESS_FLAG', { exact: true })).toHaveCount(0);
    await expect(campaigns.locator('[data-program-object="wait"]')).toContainText('Wait 2 days');
    await expect(campaigns.locator('[data-program-object="decision"]')).toContainText('Clicked the discovery email?');
    await expect(campaigns.locator('[data-program-object="exit-yes"]')).toContainText('Interest recorded');
    await expect(campaigns.locator('[data-program-object="exit-no"]')).toContainText('End discovery test');
    await expect(campaigns.locator('[data-template]')).toHaveCount(0);
    await campaigns.locator('[data-journey-campaign]').first().click();
    await expect(campaigns.locator('[data-template]')).toHaveCount(2);
    const initialTemplates = await campaigns.locator('[data-template]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-template')));
    await expect(page.frameLocator('iframe[title="Selected campaign email preview"]').getByText('Discover Your Dentist Network', { exact: true })).toBeVisible();
    await campaigns.locator('[data-journey-campaign]').nth(1).click();
    const followTemplates = await campaigns.locator('[data-template]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-template')));
    expect(followTemplates.every((id) => !initialTemplates.includes(id))).toBe(true);
    await expect(page.frameLocator('iframe[title="Selected campaign email preview"]').getByText('Need Help Finding a Dentist?', { exact: true })).toBeVisible();
    const followTemplate = campaigns.locator('[data-template]').nth(1);
    const followTemplateId = await followTemplate.getAttribute('data-template');
    await followTemplate.click();
    await page.getByRole('button', { name: 'Create campaign', exact: true }).click();
    await expect(page.getByLabel(/^Email template/)).toHaveValue(followTemplateId!);
    await expect(page.getByRole('textbox', { name: /^Subject/ })).toHaveValue(/Need Help Finding a Dentist/);
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page.getByText('Saved as version 1')).toBeVisible();
    const drafts = (await (await page.request.get(`/api/v1/accounts/${accountId}/drafts`)).json()).data;
    const draft = (await (await page.request.get(`/api/v1/drafts/${drafts[0].id}`)).json()).data;
    expect(draft.source.plan.journey.selectedCampaignId).toBe('dental-engagement-follow-up');
    expect(draft.source.plan.journey.selectedTemplateId).toBe(followTemplateId);
    expect(draft.source.plan.journey.exclusions).toEqual([]);
    expect(draft.source.plan.journey.program.nodes.some((n: any) => n.id === 'decision')).toBe(true);
    expect(draft.source.plan.journey.program.edges.some((edge: any) => edge.from === 'decision' && edge.to === 'follow' && edge.label === 'No')).toBe(true);
    await page.getByRole('button', { name: 'Close builder' }).click();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.locator('[data-strategy="welcome"]').click();
    await expect(campaigns.getByText('PET_DENTAL_PROFILE.ENROLLED_AT', { exact: true })).toBeVisible();
    await expect(campaigns.locator('[data-template]')).toHaveCount(0);
    await campaigns.locator('[data-journey-campaign]').first().click();
    await expect(page.frameLocator('iframe[title="Selected campaign email preview"]').getByText('Welcome to Your Dental Plan', { exact: true })).toBeVisible();
    await page.getByLabel('Include a published website offer (optional)').selectOption('synthetic-offer');
    const selectedPreview = page.frameLocator('iframe[title="Selected campaign email preview"]');
    await expect(selectedPreview.locator('[data-website-offer]')).toHaveCount(0);
    await page.getByLabel('I checked the official terms', { exact: false }).check();
    await expect(selectedPreview.locator('[data-website-offer]')).toContainText('Synthetic test offer');
    await expect(selectedPreview.locator('[data-website-offer]')).toContainText('Up to 20% discount');
    await selectedPreview.locator('[data-website-offer]').scrollIntoViewIfNeeded();
    await page.getByTestId('campaign-template-area').screenshot({ path: shot('website-offer-email-content') });
    await page.getByTestId('website-offer-picker').screenshot({ path: shot('website-offer-picker') });
    await page.getByRole('button', { name: 'Create campaign', exact: true }).click();
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page.getByText('Saved as version 1')).toBeVisible();
    const offerDrafts = (await (await page.request.get(`/api/v1/accounts/${accountId}/drafts`)).json()).data;
    const offerDraftId = offerDrafts.find((d: any) => d.name === 'Welcome to Your Dental Plan').id;
    const offerDraft = (await (await page.request.get(`/api/v1/drafts/${offerDraftId}`)).json()).data;
    expect(offerDraft.source.plan.journey.websiteOffer.id).toBe('synthetic-offer');
    expect(offerDraft.current.content.email.highlightValue).toContain('Up to 20%');
    expect(offerDraft.current.content.email.highlightType).toBe('offer');
    expect(offerDraft.current.content.email.ctaLink).toBe('WEBSITE_OFFER');
    await page.getByRole('button', { name: 'Close builder' }).click();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await campaigns.screenshot({ path: shot('business-journey-campaigns') });
    await page.locator('#wi-flow').screenshot({ path: shot('business-journey-flow') });
    const canvas = page.getByTestId('program-canvas');
    for (const strategy of ['engagement', 'revenue', 'welcome', 'retention', 'hygiene', 'reengage']) {
      await page.locator(`[data-strategy="${strategy}"]`).click();
      await expect(page.locator(`[data-strategy="${strategy}"]`)).toHaveAttribute('aria-pressed', 'true');
      await expect(campaigns.locator('[data-template]')).toHaveCount(0);
      await expect(campaigns.locator('[data-journey-campaign]')).toHaveCount(2);
      if (strategy === 'retention') {
        await expect(canvas.locator('[data-flow-node="decision"]')).toContainText('Member support requested?');
        await expect(canvas.locator('[data-flow-from="decision"][data-flow-to="first"][data-flow-branch="Yes"]')).toHaveCount(1);
        await expect(canvas.locator('[data-flow-node="exit-no"]')).toContainText('No support outreach');
        await expect(campaigns.getByText('Exclusion conditions', { exact: true })).toHaveCount(0);
      } else if (strategy === 'welcome') {
        await expect(canvas.locator('[data-flow-from="follow"][data-flow-to="onboarding-wait"]')).toHaveCount(1);
        await expect(canvas.locator('[data-flow-from="onboarding-wait"][data-flow-to="decision"]')).toHaveCount(1);
      } else if (strategy === 'hygiene') {
        await expect(canvas.locator('[data-flow-node="preference-check"]')).toContainText('Preferences confirmed?');
        await expect(canvas.locator('[data-flow-node="exit-no"]')).toContainText('Hold ineligible');
        await expect(campaigns.getByText('PET_MARKETING_CONTROL.PREFERENCE_CONFIRMED', { exact: true })).toBeVisible();
      } else if (strategy === 'revenue') {
        await expect(canvas.locator('[data-flow-node="completion-check"]')).toBeVisible();
        await expect(campaigns.getByText('Exclusion conditions', { exact: true })).toBeVisible();
      } else {
        await expect(canvas.locator(`[data-flow-from="decision"][data-flow-to="follow"][data-flow-branch="${strategy === 'reengage' ? 'Yes' : 'No'}"]`)).toHaveCount(1);
      }
      await page.locator('#wi-flow').screenshot({ path: shot(`strategy-flow-${strategy}`), style: 'header { visibility: hidden !important; }' });
    }
    await campaigns.locator('[data-journey-campaign]').first().click();
    await expect(page.getByRole('option', { name: /Synthetic member offer/ })).toBeDisabled();
    await page.getByLabel('Include a published website offer (optional)').selectOption('synthetic-offer');
    await page.getByLabel('I checked the official terms', { exact: false }).check();
    await expect(page.frameLocator('iframe[title="Selected campaign email preview"]').locator('[data-website-offer]')).toContainText('Synthetic test offer');
    await campaigns.locator('[data-journey-campaign]').nth(1).click();
    await expect(page.getByLabel('Include a published website offer (optional)')).toHaveValue('');
    await expect(page.frameLocator('iframe[title="Selected campaign email preview"]').locator('[data-website-offer]')).toHaveCount(0);
  }
  await page.getByLabel('Launch weekday', { exact: true }).selectOption('1');
  await page.getByLabel('Launch time', { exact: true }).fill('09:00');
  await expect(page.locator('#send-time-estimate')).toContainText('Expected open rate: 31.43%');
  await expect(page.locator('#send-time-estimate')).toContainText('Expected click rate: 3.14%');
  await page.getByLabel('Launch time', { exact: true }).fill('15:00');
  await expect(page.locator('#send-time-estimate')).toContainText('Expected open rate: 48.57%');
  await expect(page.locator('#send-time-estimate')).toContainText('Expected click rate: 4.86%');
  await expect(page.locator('#send-time-estimate')).toContainText('3 historical launches');
  await page.locator('#wi-simulation').screenshot({ path: shot('launch-time-simulation') });
});

test('account selection keeps official business websites separate', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email').fill(`business-context-${Date.now()}@example.test`);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Workspace name').fill('Business context workspace');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByLabel('Account', { exact: true }).selectOption('other');
  await page.getByLabel('Account name').fill('Dental business');
  await page.getByLabel('Official business website').fill('https://www.amildental.com.br/');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByTestId('account-brand')).toBeVisible();
  const dentalId = (await page.getByTestId('account-brand').getAttribute('data-account-id'))!;
  await expect(page.getByLabel('Account', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Official business website')).toHaveCount(0);
  await page.getByTestId('account-brand').click();
  await expect(page.getByLabel('Official business website')).toHaveValue('https://www.amildental.com.br/');
  await page.getByLabel('Official business website').fill('https://www.amildental.com.br/planos');
  await page.getByRole('button', { name: 'Save website', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save website', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  await page.getByLabel('Account name').fill('Software business');
  await page.getByLabel('Official business website').fill('https://software.example.com/');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByTestId('account-brand')).toBeVisible();
  await page.getByTestId('account-brand').click();
  await expect(page.getByLabel('Official business website')).toHaveValue('https://software.example.com/');
  await page.getByLabel('Account', { exact: true }).selectOption(dentalId);
  await expect(page.getByLabel('Official business website')).toHaveValue('https://www.amildental.com.br/planos');
  await page.getByRole('button', { name: 'Continue to application' }).click();
  await page.reload();
  await expect(page.getByTestId('account-brand')).toHaveAttribute('data-account-id', dentalId);
  await expect(page.getByLabel('Account', { exact: true })).toHaveCount(0);
  await page.getByTestId('account-brand').click();
  await expect(page.getByLabel('Official business website')).toHaveValue('https://www.amildental.com.br/planos');
  await page.screenshot({ path: shot('account-business-context'), fullPage: true });
});

test('upload to insight to draft', async ({ page }) => {
  const email = `e2e-${Date.now()}@example.test`;
  // Newer Chromium/Edge return a Promise from scrollIntoView; screens must not treat it as an
  // effect cleanup (regression: "l is not a function" on Ask AI).
  await page.addInitScript({
    content: `{ const o = Element.prototype.scrollIntoView; Element.prototype.scrollIntoView = function (...a) { o.apply(this, a); return Promise.resolve(); }; }`,
  });
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // T01: a brand-new workspace starts empty.
  await page.getByLabel('Workspace name').fill('E2E Workspace');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByLabel('Account', { exact: true }).selectOption('other');
  await page.getByLabel('Account name').fill('Main account');
  await page.getByLabel('Account timezone (IANA)').fill('UTC');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Upload an export' })).toBeVisible();
  await expect(page.getByText('No data yet')).toBeVisible();
  await expect(page.locator('#tab-briefing')).toHaveText('Summary');
  await page.screenshot({ path: shot('01-empty-summary'), fullPage: true });

  // Upload on Summary through the import wizard.
  await page.locator('#file-input').setInputFiles('tests/fixtures/golden-campaigns.csv');
  await expect(page.getByText('Confirm what this file means')).toBeVisible();
  await page.getByText('Dates in this file are in the account timezone').click();
  await page.getByLabel('Data covers from').fill('2026-09-01');
  await page.getByLabel('to (inclusive)').fill('2026-10-14');
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByText('Ready: 3 rows passed validation')).toBeVisible();
  await page.screenshot({ path: shot('02-validation'), fullPage: true });
  await page.getByRole('button', { name: 'Import 3 rows' }).click();
  await expect(page.getByText('Import complete.')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'View the report' }).click();

  // Summary: exact golden values for 2026-10-01..07 vs the preceding week.
  await page.getByLabel('From:').fill('2026-10-01');
  await page.getByLabel('To:').fill('2026-10-07');
  await expect(page.getByRole('heading', { name: 'Account Performance & Campaign Intelligence' })).toBeVisible();
  const openRow = page.locator('tr', { has: page.getByRole('button', { name: 'Total open rate' }) });
  await expect(openRow).toContainText('28.00%');
  await expect(openRow).toContainText('25.00%');
  await expect(openRow).toContainText('+3.00 pp');
  await expect(page.getByText('$9,500.00').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: '7. Best Send Time & Launch Windows' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recommendations & Next Best Actions' })).toBeVisible();
  // AI summary on every section, labelled honestly (AI is off in this run).
  await expect(page.locator('#ai-executive-summary')).toContainText('Rule-based summary (AI not configured)');
  await expect(page.locator('[data-ai-insight="campaigns"]')).toContainText('Rank 1 by click rate');
  await expect(page.getByRole('heading', { name: 'AI Next Best Actions' })).toBeVisible();
  await page.screenshot({ path: shot('03-summary'), fullPage: true });
  await page.getByRole('button', { name: 'Total open rate' }).click();
  await expect(page.getByText('total opens / delivered × 100')).toBeVisible();
  await page.keyboard.press('Escape');

  // Save Report from the same snapshot.
  await page.locator('#btn-export-report-summary').click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /CSV \(spreadsheet-safe\)/ }).click();
  expect((await download).suggestedFilename()).toMatch(/^report-overview-.*\.csv$/);
  await page.keyboard.press('Escape');

  // Analyze Campaign: one campaign against the account pattern.
  await page.locator('#tab-analyse').click();
  await page.locator('#single-campaign-select').selectOption({ label: 'Test campaign A (TEST-CAMP-A)' });
  await expect(page.getByRole('heading', { name: 'Test campaign A' })).toBeVisible();
  await expect(page.getByText('1. Campaign Performance Metrics')).toBeVisible();
  await expect(page.getByText(/Below account pattern/).first()).toBeVisible();
  await page.screenshot({ path: shot('04-analyse'), fullPage: true });

  // Compare Campaigns: VS 2 and VS Multiple.
  await page.locator('#tab-battlecard').click();
  await expect(page.getByText('Head-to-Head KPI Scorecard')).toBeVisible();
  await page.screenshot({ path: shot('05-compare-vs2'), fullPage: true });
  await page.locator('#subtab-vsmultiple').click();
  await expect(page.getByText('Comparative Battlecard (Multi-Campaign)')).toBeVisible();
  await page.screenshot({ path: shot('06-compare-multi'), fullPage: true });

  // AI Simulator: baseline from data, outcomes from the scenario engine, save, create a draft.
  await page.locator('#tab-simulator').click();
  await expect(page.getByRole('heading', { name: 'AI Marketing Strategy' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Expected Outcomes' })).toBeVisible();
  for (const removed of ['Open Multiplier', 'Click Multiplier', 'Avg Order Value', 'Uncertainty Range']) await expect(page.getByRole('slider', { name: removed, exact: true })).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Target Audience', exact: true })).toBeVisible();
  await page.getByLabel('Launch weekday', { exact: true }).selectOption('4');
  await page.getByLabel('Launch time', { exact: true }).fill('09:30');
  await expect(page.locator('#send-time-estimate')).toContainText('Thursday 09:30');
  await expect(page.locator('#send-time-estimate')).toContainText('Estimates use baseline rates');
  await expect(page.locator('#send-time-estimate')).toContainText('Expected open rate:');
  await page.getByRole('button', { name: 'Save scenario' }).click();
  await expect(page.getByText('Scenario saved with its assumptions')).toBeVisible();
  const accountOption = await page.getByTestId('account-brand').getAttribute('data-account-id');
  const scenarios = await (await page.request.get(`/api/v1/accounts/${accountOption}/scenarios`)).json();
  expect(scenarios.data[0].inputs.launchSchedule).toMatchObject({ weekday: 4, time: '09:30', basis: 'baseline' });
  await page.screenshot({ path: shot('07-simulator'), fullPage: true });
  // Without AI the strategy ranking says it is rule-based; opt-outs are really subtracted.
  await expect(page.locator('#ai-strategy-pick')).toContainText('Rule-based ranking');
  const audienceBox = page.getByRole('spinbutton', { name: 'Target audience (messages)' });
  const withExclusions = Number(await audienceBox.inputValue());
  await page.getByLabel('Subtract opt-outs from the target audience').uncheck();
  expect(Number(await audienceBox.inputValue())).toBeGreaterThan(withExclusions);
  await expect(page.getByText('Opted out · not subtracted')).toBeVisible();
  await page.getByLabel('Subtract opt-outs from the target audience').check();
  // The template picked in the simulator is the one the builder opens with.
  await expect(page.locator('#wi-campaigns [data-journey-campaign]')).toHaveCount(2);
  await expect(page.locator('#wi-campaigns [data-template]')).toHaveCount(0);
  await page.locator('#wi-campaigns [data-journey-campaign]').first().click();
  const pickedTemplate = page.locator('#wi-campaigns [data-template]').nth(1);
  const pickedId = await pickedTemplate.getAttribute('data-template');
  await pickedTemplate.click();
  await expect(pickedTemplate).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#wi-handoff')).toContainText('Not applied');
  await page.getByRole('button', { name: 'Create campaign' }).click();
  await expect(page.getByLabel(/^Email template/)).toHaveValue(pickedId!);
  // Email template: fields, in-preview editing, code view and export all work.
  await page.getByRole('textbox', { name: /^Subject/ }).fill('Hello ${CONTACTS_LIST.FIRST_NAME}, e2e subject');
  await expect(page.getByText('Hello Alex, e2e subject')).toBeVisible();
  const preview = page.frameLocator('iframe[title="Desktop preview"]');
  await expect(preview.locator('[data-edit="headline"]').first()).toHaveAttribute('contenteditable', 'true');
  await preview.locator('[data-edit="headline"]').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' now');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Headline', exact: true })).toHaveValue(/ now$/);
  await page.getByRole('tab', { name: 'RPL code' }).click();
  await expect(page.getByRole('textbox', { name: 'RPL code' })).toHaveValue(/e2e subject/);
  await page.getByRole('tab', { name: 'Visual' }).click();
  await expect(page.getByText('The code was edited')).toHaveCount(0);
  const htm = page.waitForEvent('download');
  await page.getByRole('button', { name: /Download .htm/ }).click();
  expect((await htm).suggestedFilename()).toMatch(/^[\w.-]+\.htm$/);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Saved as version 1')).toBeVisible();
  await page.screenshot({ path: shot('08-builder'), fullPage: false });
  await page.getByRole('button', { name: 'Close builder' }).click();
  await expect(page.getByText('This is a draft (authored content).')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  // Ask AI about the whole dashboard (AI not configured → labelled rule-based answers from dashboard facts).
  await page.locator('#tab-chat').click();
  await expect(page.getByText('Ask the AI Campaign Analyst')).toBeVisible();
  await expect(page.locator('#chat-campaign-select')).toHaveValue('__all__');
  // The simulator scenario built above goes with whole-dashboard questions, labelled as assumptions.
  await expect(page.locator('#chat-scenario')).toContainText('your assumptions, not results');
  await page.getByRole('button', { name: 'Explain my AI Simulator scenario and its risks' }).click();
  await expect(page.getByText(/Your AI Simulator scenario \(assumptions, not measured data\)/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Which campaigns performed best?' }).click();
  await expect(page.getByText('Rule-based answer (AI not configured)').first()).toBeVisible();
  await expect(page.getByText(/Rank 1 by click rate: "Test campaign/).first()).toBeVisible();
  await page.screenshot({ path: shot('09-ask'), fullPage: true });
  // Real time: a different period gives a new snapshot; the conversation continues on it.
  await page.locator('#chat-period-select').selectOption('30d');
  await expect(page.getByText('The dashboard data changed.')).toBeVisible();
  // One campaign; switching replaces the chat and the page keeps working.
  await page.locator('#chat-campaign-select').selectOption({ label: 'Test campaign B' });
  await expect(page.getByText(/One campaign ·/)).toBeVisible();
  await page.getByRole('button', { name: 'What was its revenue per delivered message?' }).click();
  await expect(page.getByText('Rule-based answer (AI not configured)').first()).toBeVisible();
  await expect(page.getByText('This page could not be displayed')).toHaveCount(0);
  // "Ask AI" from a Summary section opens Ask AI on the whole dashboard and answers at once.
  await page.locator('#tab-briefing').click();
  await page.locator('#period-select').selectOption('custom');
  await page.locator('#ai-executive-summary').getByRole('button', { name: 'Ask AI' }).click();
  await expect(page.locator('#chat-campaign-select')).toHaveValue('__all__');
  await expect(page.getByText(/explain what stands out for this period/)).toBeVisible();
  await expect(page.getByText('Rule-based answer (AI not configured)').first()).toBeVisible();
});
