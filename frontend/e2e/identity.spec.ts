import { test, expect } from '@playwright/test';

test('guest profile persists through refresh and is owned by its bearer session', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/');
  const entry = page.waitForResponse(response => response.url().endsWith('/api/v1/identity/enter') && response.request().method() === 'POST');
  await page.getByRole('button', {name: 'Continue as guest'}).click();
  const session = await (await entry).json();
  expect(session.profile.method).toBe('guest');
  await page.getByLabel('First name').fill('Asha');
  await page.getByLabel('Last name').fill('Rao');
  await page.getByLabel('Email').fill('asha@example.com');
  const update = page.waitForResponse(response => response.url().endsWith('/api/v1/identity/profile') && response.request().method() === 'PUT');
  await page.getByRole('button', {name: /save profile/i}).click();
  expect((await update).status()).toBe(200);
  await expect(page.getByText('Profile saved.')).toBeVisible();
  const profile = await request.get('/api/v1/identity/profile', {headers: {Authorization: `Bearer ${session.token}`}});
  expect(profile.status()).toBe(200);
  expect((await profile.json()).first_name).toBe('Asha');
  expect((await request.get('/api/v1/identity/profile')).status()).toBe(401);
  await page.reload();
  await expect(page.getByLabel('First name')).toHaveValue('Asha');
  await page.getByRole('button', {name: 'Sign out'}).click();
  await expect(page.getByRole('button', {name: 'Continue as guest'})).toBeVisible();
  expect((await request.get('/api/v1/identity/profile', {headers: {Authorization: `Bearer ${session.token}`}})).status()).toBe(401);
  expect(errors).toEqual([]);
});
