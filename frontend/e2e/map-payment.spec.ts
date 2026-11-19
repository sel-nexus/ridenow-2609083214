import { test, expect, guest } from './helpers';

test('dragging the destination pin updates the selection and the real quote route', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await guest(page);
  await page.getByRole('button', { name: 'Go to Home' }).click();
  const pin = page.locator('.destination-icon');
  await expect(pin).toBeVisible();
  await pin.click({ trial: true }); // Ensure the initial pin receives pointer events without panning.
  const before = await pin.boundingBox();
  expect(before).not.toBeNull();
  const x = before!.x + before!.width / 2;
  const y = before!.y + before!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 120, y + 70, { steps: 12 });
  await page.mouse.up();
  const selection = page.locator('.selection');
  await expect(selection).toContainText('Map pin (');
  const name = await selection.locator('p').innerText();
  expect(name).toMatch(/^Map pin \(17\.\d{5}, 78\.\d{5}\)$/);
  const quote = page.waitForResponse(r => r.url().endsWith('/booking/quotes') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Compare rides' }).click();
  const response = await quote;
  expect(response.status()).toBe(201);
  const payload = response.request().postDataJSON();
  const result = await response.json();
  expect(payload.destination.name).toBe(name);
  expect(result.destination).toEqual(payload.destination);
  expect(result.destination.lat).toBeGreaterThanOrEqual(17.2);
  expect(result.destination.lat).toBeLessThanOrEqual(17.55);
  expect(result.destination.lng).toBeGreaterThanOrEqual(78.3);
  expect(result.destination.lng).toBeLessThanOrEqual(78.7);
  expect(Math.abs(result.destination.lat - 17.4435) + Math.abs(result.destination.lng - 78.3772)).toBeGreaterThan(0.001);
  await expect(page.locator('.booking-panel')).toContainText(name);
  await expect(page.getByText(`${result.distance_km.toFixed(2)} km`)).toBeVisible();
});

for (const [method, label] of [
  ['cash', 'Cash — due at destination'],
  ['card_visa', 'Visa card'],
  ['upi_google_pay', 'UPI · Google Pay'],
  ['paytm_wallet', 'Paytm Wallet'],
  ['net_sbi', 'Net banking · SBI'],
  ['ridenow_wallet', 'RideNow Wallet / credits'],
] as const) {
  test(`simulated ${label} choice is saved and shown without charging`, async ({ page, request }) => {
    const session = await guest(page);
    await page.getByRole('button', { name: 'Go to Home' }).click();
    const search = page.waitForResponse(r => r.url().includes('/locations/search?q=RGIA') && r.status() === 200);
    await page.getByLabel('Search Hyderabad').fill('RGIA');
    const destination = (await (await search).json()).items[0];
    await page.getByRole('button', { name: /Rajiv Gandhi International Airport/ }).click();
    const quoted = page.waitForResponse(r => r.url().endsWith('/booking/quotes') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Compare rides' }).click();
    const quoteResponse = await quoted;
    expect(quoteResponse.status()).toBe(201);
    const quote = await quoteResponse.json();
    expect(quote.destination.name).toBe(destination.name);
    await page.getByLabel('Payment method').selectOption(method);
    await expect(page.getByLabel('Payment method')).toHaveValue(method);
    await expect(page.getByText(/All methods are simulated/)).toBeVisible();
    const booked = page.waitForResponse(r => r.url().endsWith('/booking/rides') && r.request().method() === 'POST');
    await page.getByRole('button', { name: /Confirm simulated booking/ }).click();
    const response = await booked;
    expect(response.status()).toBe(201);
    expect(response.request().postDataJSON()).toMatchObject({ quote_id: quote.id, payment: method });
    const booking = await response.json();
    expect(booking.payment).toBe(method);
    expect(booking.destination.name).toBe(destination.name);
    await expect(page.getByRole('heading', { name: 'Your Ride is Confirmed!' })).toBeVisible();
    const confirmation = page.locator('.confirmation');
    await expect(confirmation).toContainText(label);
    await expect(confirmation).toContainText('no payment was charged');
    await expect(confirmation).toContainText(`₹${booking.vehicle.fare.toFixed(2)}`);
    if (method === 'cash') await expect(confirmation).toContainText('Cash is due at destination in this simulation');
    const persisted = await request.get(`/api/v1/booking/rides/${booking.id}`, { headers: { Authorization: `Bearer ${session.token}` } });
    expect(persisted.status()).toBe(200);
    expect((await persisted.json()).payment).toBe(method);
  });
}
