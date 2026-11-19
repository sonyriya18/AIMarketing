import { expect, test } from '@playwright/test';

test('Amil uploads remain separate from Endeavour after switching and signing in again', async ({ page }) => {
  const email = `account-isolation-${Date.now()}@example.test`;
  await page.goto('/');
  await expect(page.getByLabel('Account', { exact: true })).toHaveCount(0);
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Workspace name').fill('Business isolation test');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Choose your account' })).toBeVisible();
  await page.getByLabel('Account', { exact: true }).selectOption('business:amil_dental');
  await page.getByRole('button', { name: 'Continue to application' }).click();
  const brand = page.getByTestId('account-brand');
  await expect(brand).toHaveAttribute('aria-label', 'Change account (Amil)');
  const amilId = (await brand.getAttribute('data-account-id'))!;
  const session = (await (await page.request.get('/api/v1/session')).json()).data;
  const headers = { 'x-csrf-token': session.csrfToken, Origin: new URL(page.url()).origin };
  const upload = await page.request.post(`/api/v1/accounts/${amilId}/imports`, { headers, multipart: { file: { name: 'amil-only.csv', mimeType: 'text/csv', buffer: Buffer.from('Campaign ID,Launch Date,Channel,Sent,Delivered,Unique Opens,Unique Clicks,Conversions,Orders,Revenue\nAMIL-ONLY,2026-10-05,Email,1000,1000,300,30,10,10,100') } } });
  expect(upload.status()).toBe(201);
  const imp = (await upload.json()).data;
  const validation = await page.request.post(`/api/v1/imports/${imp.id}/validate`, { headers, data: { mapping: { ...imp.detection.proposal, timezoneConfirmed: true, datasetName: 'Amil exclusive upload', coverageStart: '2026-10-01', coverageEnd: '2026-10-20' } } });
  expect((await validation.json()).data.ok).toBe(true);
  expect((await page.request.post(`/api/v1/imports/${imp.id}/commit`, { headers })).status()).toBe(202);
  await expect.poll(async () => (await (await page.request.get(`/api/v1/imports/${imp.id}`)).json()).data.status).toBe('completed');
  await page.reload();
  await expect(page.getByText('Amil exclusive upload', { exact: false }).first()).toBeVisible();
  await brand.click();
  await page.getByLabel('Account', { exact: true }).selectOption('business:endeavour_dm');
  await expect(page.getByText('https://www.danmurphys.com.au/dm/home', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/endeavour-account-selection.png', fullPage: true });
  await page.getByRole('button', { name: 'Continue to application' }).click();
  await expect(brand).toHaveAttribute('aria-label', 'Change account (Endeavour Group - DM)');
  const dmId = (await brand.getAttribute('data-account-id'))!;
  expect(dmId).not.toBe(amilId);
  for (const resource of ['datasets', 'imports', 'drafts', 'scenarios']) {
    const response = await page.request.get(`/api/v1/accounts/${dmId}/${resource}`);
    expect(response.ok()).toBe(true);
    expect((await response.json()).data).toEqual([]);
  }
  for (const tab of ['briefing', 'simulator', 'analyse', 'battlecard', 'chat']) {
    await page.locator(`#tab-${tab}`).click();
    await expect(page.getByText('Amil exclusive upload', { exact: false })).toHaveCount(0);
    await expect(page.locator('#wi-strategy')).toHaveCount(0);
    await expect(page.getByLabel('Account', { exact: true })).toHaveCount(0);
  }
  await page.reload();
  await expect(brand).toHaveAttribute('data-account-id', dmId);
  await brand.click();
  await expect(page.getByLabel('Official business website')).toHaveValue('https://www.danmurphys.com.au/dm/home');
  await page.getByLabel('Account', { exact: true }).selectOption(amilId);
  await page.getByRole('button', { name: 'Continue to application' }).click();
  await expect(page.getByText('Amil exclusive upload', { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('Account', { exact: true })).toHaveCount(0);
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Choose your account' })).toBeVisible();
  await expect(brand).toHaveCount(0);
  await page.getByLabel('Account', { exact: true }).selectOption(dmId);
  await page.getByRole('button', { name: 'Continue to application' }).click();
  await expect(brand).toHaveAttribute('data-account-id', dmId);
  await expect(page.getByText('Amil exclusive upload', { exact: false })).toHaveCount(0);
});
