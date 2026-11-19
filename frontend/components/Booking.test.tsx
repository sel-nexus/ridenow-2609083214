// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Booking from './Booking';

const destination = {name: 'Airport', lat: 17.2403, lng: 78.4294};
const pickup = {name: 'Simulated pickup, Hitec City', lat: 17.4435, lng: 78.3772};
const vehicle = {id: 'bike', name: 'Bike', seats: 1, tier_fee: 0, eta_minutes: 3, base_fare: 100, original_fare: 100, fare: 110};
const quote = {id: 'q1', pickup, destination, distance_km: 17, surge_multiplier: 1.1, vehicles: [vehicle]};
const response = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), {status}));
afterEach(() => {cleanup(); vi.restoreAllMocks();});

it('discloses surge and simulated cash and shows the persisted confirmation', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => String(url).endsWith('/quotes')
    ? response(quote, 201)
    : response({id: 'ride1', quote_id: 'q1', pickup, destination, vehicle, payment: 'cash', status: 'confirmed', distance_km: 17, surge_multiplier: 1.1}, 201));
  const user = userEvent.setup();
  render(<Booking token="secret" destination={destination} onBack={() => {}} />);
  expect(await screen.findByText(/1.1× simulated demand surge/)).toBeInTheDocument();
  expect(screen.getByText('₹100.00')).toBeInTheDocument();
  await user.click(screen.getByRole('button', {name: /Confirm simulated booking/}));
  expect(screen.getByText('Processing simulated booking…')).toBeInTheDocument();
  expect(await screen.findByText('Your Ride is Confirmed!', {}, {timeout: 2500})).toBeInTheDocument();
  expect(screen.getByText(/Cash is due at destination in this simulation/)).toBeInTheDocument();
  const call = fetcher.mock.calls.find(([url]) => String(url).endsWith('/rides'));
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({quote_id: 'q1', vehicle: 'bike', payment: 'cash'});
  expect(new Headers(call?.[1]?.headers).get('Authorization')).toBe('Bearer secret');
  await user.click(screen.getByRole('button', {name: 'Track Your Ride'}));
  expect(screen.getByText(/Tracking is not available yet/)).toBeInTheDocument();
});

it('offers retry after a quote error and shows booking errors without confirmation', async () => {
  let fail = true;
  vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    if (String(url).endsWith('/rides')) return response({}, 500);
    return fail ? Promise.reject(new Error('offline')) : response(quote, 201);
  });
  const user = userEvent.setup();
  render(<Booking token="secret" destination={destination} onBack={() => {}} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to reach');
  fail = false; await user.click(screen.getByRole('button', {name: 'Retry estimate'}));
  await screen.findByText(/1.1× simulated demand surge/);
  await user.selectOptions(screen.getByLabelText('Payment method'), 'card_visa');
  await user.click(screen.getByRole('button', {name: /Confirm simulated booking/}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
  expect(screen.queryByText('Your Ride is Confirmed!')).not.toBeInTheDocument();
});
