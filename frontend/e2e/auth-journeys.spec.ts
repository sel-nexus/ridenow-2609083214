import { test, expect } from './helpers';

test('phone entry validates input, accepts simulated OTP and restores the session', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Country code')).toHaveValue('+91');
  await page.getByLabel('Phone number').fill('12');
  await page.getByRole('button', { name: 'Continue with phone' }).click();
  await expect(page.getByRole('region', { name: 'Get started' }).getByRole('alert')).toHaveText('Enter a valid phone number using digits.');
  await page.getByLabel('Phone number').fill('9876543210');
  const start = page.waitForResponse(r => r.url().endsWith('/identity/phone/start') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Continue with phone' }).click();
  expect((await start).status()).toBe(200);
  await expect(page.getByText(/no SMS was sent/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /Resend in/ })).toBeDisabled();
  await page.getByLabel('Verification code').fill('123');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Get started' }).getByRole('alert')).toHaveText('Enter 4 or 6 digits.');
  await page.getByLabel('Verification code').fill('1234');
  const verification = page.waitForResponse(r => r.url().endsWith('/identity/phone/verify') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const response = await verification;
  expect(response.status()).toBe(200);
  const session = await response.json();
  expect(session.profile.method).toBe('phone');
  expect(session.profile.phone).toBe('+919876543210');
  await expect(page.getByText(/phone demo/)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Phone', { exact: false })).toHaveValue('+919876543210');
  await page.screenshot({ path: test.info().outputPath('desktop-phone-profile.png'), fullPage: true });
});

for (const method of ['google', 'apple'] as const) {
  test(`${method} simulated entry creates and restores a profile`, async ({ page }) => {
    await page.goto('/');
    const entry = page.waitForResponse(r => r.url().endsWith('/identity/enter') && r.request().method() === 'POST');
    await page.getByRole('button', { name: method === 'google' ? 'Google' : 'Apple', exact: true }).click();
    const response = await entry;
    expect(response.status()).toBe(200);
    const session = await response.json();
    expect(session.profile.method).toBe(method);
    await expect(page.getByText(`${method} demo`, { exact: false })).toBeVisible();
    await page.reload();
    await expect(page.getByText(`${method} demo`, { exact: false })).toBeVisible();
    const profile = page.waitForResponse(r => r.url().endsWith('/identity/profile') && r.request().method() === 'GET');
    await page.reload();
    expect((await (await profile).json()).id).toBe(session.profile.id);
  });
}
