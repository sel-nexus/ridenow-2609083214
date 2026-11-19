import { test, expect } from '@playwright/test';

test('guest saves simulated credits and a future reservation over real HTTP', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.goto('/');
  await page.getByRole('button', {name: 'Continue as guest'}).click();
  await expect(page.getByText(/rider rating/)).toBeVisible();
  await page.getByRole('link', {name: 'Account', exact: true}).click();
  await page.getByRole('button', {name: 'Add mock funds'}).click();
  await expect(page.getByText(/Simulated balance: ₹100.00/)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/Simulated balance: ₹100.00/)).toBeVisible();
  await page.getByRole('link', {name: 'Services', exact: true}).click();
  const date = new Date(Date.now() + 86400000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  await page.getByLabel('Future date and time').fill(local);
  await page.getByRole('button', {name: 'Save reservation'}).click();
  await expect(page.getByText('Reservation saved. No payment or dispatch occurred.')).toBeVisible();
  await page.getByRole('link', {name: 'Activity', exact: true}).click();
  await expect(page.getByText(/estimate ₹/)).toBeVisible();
  expect(errors).toEqual([]);
});
