import { test as base, expect, type Page } from '@playwright/test';

// Install listeners before each test can navigate, including when an assertion fails.
export const test = base.extend<{ browserErrors: void }>({
  browserErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await use();
    expect(errors, 'Browser console errors and uncaught exceptions').toEqual([]);
  }, { auto: true }],
});
export { expect };

export async function guest(page: Page) {
  await page.goto('/');
  const entry = page.waitForResponse(r => r.url().endsWith('/api/v1/identity/enter') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Continue as guest' }).click();
  const response = await entry;
  expect(response.status()).toBe(200);
  const session = await response.json();
  expect(session.profile.method).toBe('guest');
  await expect(page.getByRole('button', { name: 'Go to Home' })).toBeVisible();
  return session;
}

export function localFuture(days: number) {
  const date = new Date(Date.now() + days * 86400000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
