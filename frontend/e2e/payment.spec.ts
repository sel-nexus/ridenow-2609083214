import { test, expect, guest } from './helpers';

const methods = [
  ['cash', 'Cash — due at destination'], ['card_visa', 'Visa card'],
  ['card_mastercard', 'Mastercard'], ['card_rupay', 'RuPay'], ['card_amex', 'Amex'],
  ['upi_google_pay', 'UPI · Google Pay'], ['upi_phonepe', 'UPI · PhonePe'],
  ['upi_paytm', 'UPI · Paytm'], ['upi_custom', 'UPI · custom'],
  ['paytm_wallet', 'Paytm Wallet'], ['amazon_pay', 'Amazon Pay'],
  ['net_sbi', 'Net banking · SBI'], ['net_hdfc', 'Net banking · HDFC'],
  ['net_icici', 'Net banking · ICICI'], ['net_axis', 'Net banking · Axis'],
  ['ridenow_wallet', 'RideNow Wallet / credits'],
] as const;

for (const [method, label] of methods) {
  test(`simulated ${label} booking saves only the payment method`, async ({ page, request }) => {
    const session = await guest(page);
    await page.getByRole('button', { name: 'Go to Home' }).click();
    await page.getByLabel('Search Hyderabad').fill('RGIA');
    await page.getByRole('button', { name: /Rajiv Gandhi International Airport/ }).click();
    const quoted = page.waitForResponse(r => r.url().endsWith('/booking/quotes') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Compare rides' }).click();
    const quoteResponse = await quoted;
    expect(quoteResponse.status()).toBe(201);
    const quote = await quoteResponse.json();
    const selector = page.getByLabel('Payment method');
    await expect(selector.locator('option')).toHaveCount(16);
    await selector.selectOption(method);
    await expect(page.getByText(/Do not enter real payment credentials/)).toBeVisible();

    const observed: string[] = [];
    page.on('request', r => { if (r.postData()) observed.push(`${r.url()} ${r.postData()}`); });
    if (method.startsWith('card_')) {
      await page.getByLabel('Test card number').fill('0000000000000000');
      await page.getByLabel('Test expiry').fill('00/00');
      await page.getByLabel('Test CVV').fill('000');
    } else if (method === 'upi_custom') {
      await page.getByLabel('Test UPI ID').fill('test@example.invalid');
    }
    const booked = page.waitForResponse(r => r.url().endsWith('/booking/rides') && r.request().method() === 'POST');
    await page.getByRole('button', { name: /Confirm simulated booking/ }).click();
    const response = await booked;
    expect(response.status()).toBe(201);
    expect(response.request().postDataJSON()).toEqual({ quote_id: quote.id, vehicle: 'bike', payment: method });
    const ride = await response.json();
    expect(ride.payment).toBe(method);
    expect(ride.destination).toEqual(quote.destination);
    await expect(page.getByRole('heading', { name: 'Your Ride is Confirmed!' })).toBeVisible();
    await expect(page.locator('.confirmation')).toContainText(label);
    await expect(page.locator('.confirmation')).toContainText('no payment was charged');
    await expect(page.locator('.confirmation')).toContainText(`₹${ride.vehicle.fare.toFixed(2)}`);
    await expect(page.getByLabel('Test card number')).toHaveCount(0);
    await expect(page.getByLabel('Test UPI ID')).toHaveCount(0);
    const saved = await request.get(`/api/v1/booking/rides/${ride.id}`, { headers: { Authorization: `Bearer ${session.token}` } });
    expect(saved.status()).toBe(200);
    const savedText = await saved.text();
    expect(JSON.parse(savedText)).toEqual(ride);
    for (const text of [...observed, savedText]) {
      expect(text).not.toContain('0000000000000000');
      expect(text).not.toContain('00/00');
      expect(text).not.toContain('test@example.invalid');
      expect(text).not.toMatch(/"(?:cvv|card_number|upi_id|expiry)"/i);
    }
  });
}

test('invalid payment details are rejected and switching methods discards them', async ({ page }) => {
  await guest(page);
  await page.getByRole('button', { name: 'Go to Home' }).click();
  await page.getByLabel('Search Hyderabad').fill('RGIA');
  await page.getByRole('button', { name: /Rajiv Gandhi International Airport/ }).click();
  const quoted = page.waitForResponse(r => r.url().endsWith('/booking/quotes') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Compare rides' }).click();
  expect((await quoted).status()).toBe(201);
  const selector = page.getByLabel('Payment method');
  let bookings = 0;
  page.on('request', r => { if (r.url().endsWith('/booking/rides') && r.method() === 'POST') bookings++; });
  await selector.selectOption('card_visa');
  await page.getByLabel('Test card number').fill('4111111111111111');
  await page.getByRole('button', { name: /Confirm simulated booking/ }).click();
  await expect(page.locator('.booking-panel').getByRole('alert')).toContainText('Use only the displayed test card values');
  await selector.selectOption('upi_custom');
  await page.getByLabel('Test UPI ID').fill('person@bank');
  await page.getByRole('button', { name: /Confirm simulated booking/ }).click();
  await expect(page.locator('.booking-panel').getByRole('alert')).toContainText('Use only the displayed test UPI ID');
  await selector.selectOption('card_mastercard');
  await expect(page.getByLabel('Test card number')).toHaveValue('');
  await selector.selectOption('upi_custom');
  await expect(page.getByLabel('Test UPI ID')).toHaveValue('');
  expect(bookings).toBe(0);
});
