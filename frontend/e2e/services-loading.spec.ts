import { test, expect, guest } from './helpers';

test('Services Packages preselects Parcel after a real quote; recipient validation recovers', async ({ page }) => {
  await guest(page);
  await page.getByRole('link', { name: 'Services', exact: true }).click();
  await page.getByRole('link', { name: 'Packages', exact: true }).click();
  await expect(page.getByLabel('Search Hyderabad')).toBeVisible();
  const search = page.waitForResponse(r => r.url().includes('/locations/search?q=RGIA') && r.status() === 200);
  await page.getByLabel('Search Hyderabad').fill('RGIA');
  expect((await (await search).json()).items[0].name).toContain('Rajiv Gandhi');
  await page.getByRole('button', { name: /Rajiv Gandhi International Airport/ }).click();
  const quote = page.waitForResponse(r => r.url().endsWith('/booking/quotes') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Compare rides' }).click();
  const response = await quote;
  expect(response.status()).toBe(201);
  expect((await response.json()).vehicles.some((v: { id: string }) => v.id === 'parcel')).toBe(true);
  await expect(page.getByRole('radio', { name: /Parcel/ })).toBeChecked();
  await page.getByRole('button', { name: /Confirm simulated booking/ }).click();
  await expect(page.locator('.booking-panel').getByRole('alert')).toContainText('Enter a recipient name and a valid');
  await page.getByLabel('Package type').selectOption('medium_box');
  await expect(page.getByLabel('Courier vehicle')).toHaveValue('auto_car');
  await page.getByLabel('Recipient name').fill('Test Recipient');
  await page.getByLabel('Recipient phone').fill('9876543210');
  const saved = page.waitForResponse(r => r.url().endsWith('/booking/rides') && r.request().method() === 'POST');
  await page.getByRole('button', { name: /Confirm simulated booking/ }).click();
  const booking = await saved;
  expect(booking.status()).toBe(201);
  expect((await booking.json()).vehicle.id).toBe('parcel');
  await expect(page.getByRole('heading', { name: 'Your Ride is Confirmed!' })).toBeVisible();
});

test('search remains loading while its actual backend response is held, then shows real results', async ({ page }) => {
  await guest(page);
  await page.getByRole('button', { name: 'Go to Home' }).click();
  let release!: () => void;
  let received!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const backendReceived = new Promise<void>(resolve => { received = resolve; });
  await page.route('**/api/v1/locations/search?q=RGIA*', async route => {
    try {
      const response = await route.fetch(); // The real Next proxy and backend still handle the request.
      received();
      await gate;
      await route.fulfill({ response }); // Deliver exactly that response, without substituting data.
    } catch (error) {
      received();
      throw error;
    }
  });
  try {
    await page.getByLabel('Search Hyderabad').fill('RGIA');
    await backendReceived;
    await expect(page.getByRole('status').filter({ hasText: 'Searching locations' })).toBeVisible();
  } finally {
    release();
  }
  await expect(page.getByRole('button', { name: /Rajiv Gandhi International Airport/ })).toBeVisible();
  await expect(page.getByText('Searching locations…')).toHaveCount(0);
  const emptyResponse = page.waitForResponse(r => r.url().includes('/locations/search?q=no-such-place-xyz') && r.status() === 200);
  await page.getByLabel('Search Hyderabad').fill('no-such-place-xyz');
  const empty = await emptyResponse;
  expect((await empty.json()).items).toEqual([]);
  await expect(page.getByText('No places found. Try another search or choose a point on the map.')).toBeVisible();
});
