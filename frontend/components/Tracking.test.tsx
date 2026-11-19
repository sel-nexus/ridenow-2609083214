// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Tracking from './Tracking';

const booking = {id: 'ride1', quote_id: 'q1', pickup: {name: 'Pickup', lat: 17.44, lng: 78.38}, destination: {name: 'Airport', lat: 17.24, lng: 78.43}, distance_km: 20, surge_multiplier: 1, vehicle: {id: 'bike', name: 'Bike', seats: 1, tier_fee: 0, eta_minutes: 3, base_fare: 30, original_fare: 30, fare: 30}, payment: 'cash', status: 'confirmed', created_at: '', parcel: null};
const initial = {booking, state: 'arrived', driver: {name: 'Rajesh Reddy', rating: 4.88, trips: 1600, model: 'Honda', plate: 'TS 09 UA 4821'}, pin: '1234', attempts: 0, arrival_seconds: 0, seconds_to_arrival: 0, matching_seconds: 0, progress: 0};
afterEach(() => {cleanup(); vi.restoreAllMocks();});

it('shows the persisted assignment and submits the PIN before starting', async () => {
  let state = initial;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => {
    if (options?.method === 'POST') state = {...state, state: 'in_trip'};
    return Promise.resolve(new Response(JSON.stringify(state), {status: 200}));
  });
  const user = userEvent.setup();
  render(<Tracking token="token" booking={booking} onBack={() => {}} />);
  expect(await screen.findByText('Rajesh Reddy')).toBeInTheDocument();
  expect(screen.getByText(/TS 09 UA 4821/)).toBeInTheDocument();
  expect(screen.getByText('1234')).toBeInTheDocument();
  expect(screen.getByRole('button', {name: 'Start Trip'})).toBeDisabled();
  await user.type(screen.getByLabelText(/Enter safety PIN/), '1234');
  await user.click(screen.getByRole('button', {name: 'Start Trip'}));
  expect(await screen.findByText('Trip in progress')).toBeInTheDocument();
  const call = fetcher.mock.calls.find(([url]) => String(url).endsWith('/pin'));
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({pin: '1234'});
  expect(new Headers(call?.[1]?.headers).get('Authorization')).toBe('Bearer token');
});

it('asks for cancellation confirmation and reports a failed request', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => options?.method === 'POST'
    ? Promise.resolve(new Response('{}', {status: 409}))
    : Promise.resolve(new Response(JSON.stringify(initial), {status: 200})));
  const user = userEvent.setup();
  render(<Tracking token="token" booking={booking} onBack={() => {}} />);
  await screen.findByText('Driver has arrived');
  await user.click(screen.getByRole('button', {name: 'Cancel journey'}));
  expect(screen.getByText(/There is no cancellation fee/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', {name: 'Confirm cancellation'}));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong'));
});

it('labels delivered parcel proof as simulated', async () => {
  const parcelBooking = {...booking, vehicle: {...booking.vehicle, id: 'parcel', name: 'Parcel'}};
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({...initial, booking: parcelBooking, state: 'delivered', progress: 1}), {status: 200}));
  render(<Tracking token="token" booking={parcelBooking} onBack={() => {}} />);
  expect(await screen.findByText('Simulated proof of delivery')).toBeInTheDocument();
  expect(screen.getByRole('img', {name: /illustration of a parcel at a doorstep/i})).toHaveAttribute('src', '/delivery-illustration.svg');
  expect(screen.getByText(/Illustration only.*no real delivery.*verified/i)).toBeInTheDocument();
});

it('offers feedback immediately on completion, saves it, and restores it on remount', async () => {
  let feedback: {rating: number; compliments: string[]; tip_paise: number} | null = null;
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    if (String(url).endsWith('/feedback')) { feedback = JSON.parse(String(init?.body)); return Promise.resolve(new Response(JSON.stringify(feedback), {status: 200})); }
    if (String(url).includes('/activity/')) return Promise.resolve(new Response(JSON.stringify({feedback}), {status: 200}));
    return Promise.resolve(new Response(JSON.stringify({...initial, state: 'completed', progress: 1}), {status: 200}));
  });
  const user = userEvent.setup(); const view = render(<Tracking token="token" booking={booking} onBack={() => {}} />);
  await screen.findByText('Trip completed');
  await user.selectOptions(await screen.findByLabelText('Rating'), '4');
  await user.click(screen.getByLabelText('Polite driver'));
  await user.click(screen.getByRole('button', {name: '₹20.00'}));
  await user.click(screen.getByRole('button', {name: 'Save feedback'}));
  expect(await screen.findByText(/Feedback saved/)).toHaveTextContent('no payment was made');
  expect(feedback).toEqual({rating: 4, compliments: ['Polite driver'], tip_paise: 2000});
  view.unmount(); render(<Tracking token="token" booking={booking} onBack={() => {}} />);
  expect(await screen.findByLabelText('Rating')).toHaveValue('4');
  expect(screen.getByLabelText('Polite driver')).toBeChecked();
});

it.each([true, false])('shares a simulated reference and reports clipboard outcome (success: %s)', async success => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(initial), {status: 200}));
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, 'writeText');
  if (success) writeText.mockResolvedValue();
  else writeText.mockRejectedValue(new Error('Permission denied'));
  render(<Tracking token="token" booking={booking} onBack={() => {}} />);
  await user.click(await screen.findByRole('button', {name: 'Safety shield'}));
  await user.click(screen.getByRole('button', {name: 'Share Trip'}));
  expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/#simulated-trip-ride1`);
  expect(await screen.findByText(success ? 'Simulated trip reference copied. It is not a live tracking link.' : 'Could not copy the simulated trip reference.')).toBeInTheDocument();
});

it('shows mock chat and safety actions without claiming real contact', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(initial), {status: 200}));
  const user = userEvent.setup();
  render(<Tracking token="token" booking={booking} onBack={() => {}} />);
  await user.click(await screen.findByRole('button', {name: 'Mock chat'}));
  expect(screen.getByText('Mock chat · no message is sent.')).toBeInTheDocument();
  await user.click(screen.getByRole('button', {name: "I'm at the pickup point"}));
  expect(screen.getByText(/Simulated message: I'm at the pickup point/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', {name: 'Close chat'}));
  expect(screen.queryByText('Mock chat · no message is sent.')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', {name: 'Safety shield'}));
  expect(screen.getByText(/Simulated SOS 112 · no emergency service will be contacted/)).toBeInTheDocument();
  expect(screen.getByText(/Simulated GPS: 17.44000, 78.38000 · TS 09 UA 4821/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', {name: 'Simulate SOS'}));
  expect(screen.getByText('SOS simulation only: no emergency service was contacted.')).toBeInTheDocument();
});

it('raises and acknowledges simulated RideCheck during a trip', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response(JSON.stringify({...initial, state: 'in_trip'}), {status: 200})));
  vi.useFakeTimers();
  try {
    render(<Tracking token="token" booking={booking} onBack={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('Trip in progress')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(screen.getByText(/Everything okay on your trip\? \(Simulated RideCheck\)/)).toBeInTheDocument();
    vi.useRealTimers();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', {name: 'Yes, I’m okay'}));
    expect(screen.queryByText(/Everything okay on your trip/)).not.toBeInTheDocument();
    expect(screen.getByText('RideCheck acknowledged.')).toBeInTheDocument();
  } finally { vi.useRealTimers(); }
});

it('ignores an older polling response after a newer response', async () => {
  let resolveOld!: (response: Response) => void;
  let calls = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    calls += 1;
    if (calls === 1) return new Promise(resolve => { resolveOld = resolve; });
    return Promise.resolve(new Response(JSON.stringify({...initial, state: 'in_trip'}), {status: 200}));
  });
  vi.useFakeTimers();
  try {
    render(<Tracking token="token" booking={booking} onBack={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText('Trip in progress')).toBeInTheDocument();
    await act(async () => { resolveOld(new Response(JSON.stringify(initial), {status: 200})); });
    expect(screen.getByText('Trip in progress')).toBeInTheDocument();
    expect(screen.queryByText('Driver has arrived')).not.toBeInTheDocument();
  } finally { vi.useRealTimers(); }
});

it('reports feedback save failure without claiming it was saved', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    if (init?.method === 'PUT') return Promise.resolve(new Response('{"detail":"Save failed"}', {status: 500}));
    if (String(url).includes('/activity/')) return Promise.resolve(new Response('{"feedback":null}', {status: 200}));
    return Promise.resolve(new Response(JSON.stringify({...initial, state: 'completed'}), {status: 200}));
  });
  const user = userEvent.setup(); render(<Tracking token="token" booking={booking} onBack={() => {}} />);
  await user.click(await screen.findByRole('button', {name: 'Save feedback'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Save failed');
  expect(screen.queryByText(/Feedback saved/)).not.toBeInTheDocument();
});
