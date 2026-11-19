// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Booking from './Booking';

const destination = {name: 'Airport', lat: 17.2403, lng: 78.4294};
const pickup = {name: 'Simulated pickup, Hitec City', lat: 17.4435, lng: 78.3772};
const vehicle = {id: 'bike', name: 'Bike', seats: 1, tier_fee: 0, eta_minutes: 3, base_fare: 100, original_fare: 100, fare: 110};
const quote = {id: 'q1', pickup, destination, distance_km: 17, surge_multiplier: 1.1, vehicles: [vehicle]};
const response = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), {status}));
afterEach(() => {cleanup(); vi.restoreAllMocks();});

it('creates one quote in StrictMode and submits that quote ID when booking', async () => {
  let quoteCount = 0;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    if (String(url).endsWith('/quotes')) {
      quoteCount += 1;
      return response({...quote, id: `quote-${quoteCount}`}, 201);
    }
    return response({id: 'ride1', quote_id: 'quote-1', pickup, destination, vehicle, payment: 'cash'}, 201);
  });
  const user = userEvent.setup();
  render(<React.StrictMode><Booking token="secret" destination={destination} onBack={() => {}} /></React.StrictMode>);
  await user.click(await screen.findByRole('button', {name: /Confirm simulated booking/}));
  expect(await screen.findByText('Your Ride is Confirmed!', {}, {timeout: 2500})).toBeInTheDocument();
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/quotes'))).toHaveLength(1);
  const ride = fetcher.mock.calls.find(([url]) => String(url).endsWith('/rides'));
  expect(JSON.parse(String(ride?.[1]?.body)).quote_id).toBe('quote-1');
});

it.each(['success', 'error'])('ignores a stale quote %s after the destination changes', async (outcome) => {
  let settleOld!: (value: Response) => void;
  let rejectOld!: (reason: Error) => void;
  const oldResponse = new Promise<Response>((resolve, reject) => { settleOld = resolve; rejectOld = reject; });
  const nextDestination = {name: 'Station', lat: 17.4, lng: 78.5};
  let count = 0;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    count += 1;
    return count === 1 ? oldResponse : response({...quote, id: 'new', destination: nextDestination, distance_km: 42}, 201);
  });
  const {rerender} = render(<Booking token="secret" destination={destination} onBack={() => {}} />);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  rerender(<Booking token="secret" destination={nextDestination} onBack={() => {}} />);
  expect(await screen.findByText('42.00 km')).toBeInTheDocument();
  await act(async () => {
    if (outcome === 'success') settleOld(new Response(JSON.stringify(quote), {status: 201}));
    else rejectOld(new Error('offline'));
    await oldResponse.catch(() => {});
  });
  expect(screen.getByText('42.00 km')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByText('Getting your estimate…')).not.toBeInTheDocument();
});

it('discloses surge and simulated cash and shows the persisted confirmation', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => String(url).endsWith('/quotes')
    ? response(quote, 201)
    : String(url).includes('/tracking/') ? response({booking: {id: 'ride1', pickup, destination, vehicle}, state: 'matching', driver: null, pin: null, attempts: 0, arrival_seconds: 10, seconds_to_arrival: 10, matching_seconds: 2, progress: 0})
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
  expect(await screen.findByText(/Finding your nearest driver/)).toBeInTheDocument();
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

it('rejects a blank recipient and invalid phone numbers without creating a ride', async () => {
  const parcelQuote = {...quote, vehicles: [{...vehicle, id: 'parcel', name: 'Parcel'}]};
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(() => response(parcelQuote, 201));
  const user = userEvent.setup();
  render(<Booking token="secret" destination={destination} onBack={() => {}} initialVehicle="parcel" />);
  const submit = await screen.findByRole('button', {name: /Confirm simulated booking/});
  await user.type(screen.getByLabelText('Recipient name'), '   ');
  await user.type(screen.getByLabelText('Recipient phone'), '9876543210');
  await user.click(submit);
  expect(screen.getByRole('alert')).toHaveTextContent('Enter a recipient name and a valid 10–15 digit phone number.');
  await user.clear(screen.getByLabelText('Recipient name'));
  await user.type(screen.getByLabelText('Recipient name'), 'Asha');
  await user.clear(screen.getByLabelText('Recipient phone'));
  await user.type(screen.getByLabelText('Recipient phone'), '123456789');
  await user.click(submit);
  expect(screen.getByRole('alert')).toHaveTextContent('valid 10–15 digit phone number');
  await user.clear(screen.getByLabelText('Recipient phone'));
  await user.type(screen.getByLabelText('Recipient phone'), '12345abc67890');
  await user.click(submit);
  expect(screen.getByRole('alert')).toHaveTextContent('valid 10–15 digit phone number');
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/rides'))).toHaveLength(0);
  expect(screen.queryByText('Your Ride is Confirmed!')).not.toBeInTheDocument();
});

it('sends valid parcel details, reports rejection, and permits a retry', async () => {
  const parcelVehicle = {...vehicle, id: 'parcel', name: 'Parcel'};
  const parcelQuote = {...quote, vehicles: [parcelVehicle]};
  let reject = true;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    if (String(url).endsWith('/quotes')) return response(parcelQuote, 201);
    if (reject) return response({detail: 'Parcel booking unavailable'}, 409);
    return response({id: 'parcel1', quote_id: 'q1', pickup, destination, vehicle: parcelVehicle, payment: 'cash'}, 201);
  });
  const user = userEvent.setup();
  render(<Booking token="secret" destination={destination} onBack={() => {}} initialVehicle="parcel" />);
  await user.type(await screen.findByLabelText('Recipient name'), 'Asha');
  await user.type(screen.getByLabelText('Recipient phone'), '+919876543210');
  await user.selectOptions(screen.getByLabelText('Package type'), 'medium_box');
  expect(screen.getByLabelText('Courier vehicle')).toHaveValue('auto_car');
  const submit = screen.getByRole('button', {name: /Confirm simulated booking/});
  await user.click(submit);
  expect(await screen.findByRole('alert')).toHaveTextContent('Parcel booking unavailable');
  expect(submit).toBeEnabled();
  expect(screen.queryByText('Your Ride is Confirmed!')).not.toBeInTheDocument();
  const call = fetcher.mock.calls.find(([url]) => String(url).endsWith('/rides'));
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({quote_id: 'q1', vehicle: 'parcel', payment: 'cash', parcel: {package_type: 'medium_box', recipient_name: 'Asha', recipient_phone: '+919876543210', instructions: '', courier_vehicle: 'auto_car'}});
  reject = false;
  await user.click(submit);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(await screen.findByText('Your Ride is Confirmed!', {}, {timeout: 2500})).toBeInTheDocument();
});

it('offers all 16 methods and clears test inputs when switching payment methods', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => response(quote, 201));
  const user = userEvent.setup();
  render(<Booking token="secret" destination={destination} onBack={() => {}} />);
  const selector = await screen.findByLabelText('Payment method');
  expect(screen.getAllByRole('option')).toHaveLength(16);
  await user.selectOptions(selector, 'card_visa');
  expect(screen.getByText(/Do not enter real payment credentials/)).toBeInTheDocument();
  await user.type(screen.getByLabelText('Test card number'), '0000000000000000');
  await user.type(screen.getByLabelText('Test expiry'), '00/00');
  await user.type(screen.getByLabelText('Test CVV'), '000');
  await user.selectOptions(selector, 'upi_custom');
  await user.type(screen.getByLabelText('Test UPI ID'), 'test@example.invalid');
  await user.selectOptions(selector, 'card_mastercard');
  expect(screen.getByLabelText('Test card number')).toHaveValue('');
  expect(screen.getByLabelText('Test expiry')).toHaveValue('');
  expect(screen.getByLabelText('Test CVV')).toHaveValue('');
  await user.selectOptions(selector, 'upi_custom');
  expect(screen.getByLabelText('Test UPI ID')).toHaveValue('');
});

it('rejects real-looking and incomplete card or UPI details without creating a ride', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(() => response(quote, 201));
  const user = userEvent.setup();
  render(<Booking token="secret" destination={destination} onBack={() => {}} />);
  const selector = await screen.findByLabelText('Payment method');
  const submit = screen.getByRole('button', {name: /Confirm simulated booking/});
  await user.selectOptions(selector, 'card_visa');
  await user.type(screen.getByLabelText('Test card number'), '4111111111111111');
  await user.click(submit);
  expect(screen.getByRole('alert')).toHaveTextContent('Use only the displayed test card values');
  await user.clear(screen.getByLabelText('Test card number'));
  await user.type(screen.getByLabelText('Test card number'), '0000000000000000');
  await user.click(submit);
  expect(screen.getByRole('alert')).toHaveTextContent('Use only the displayed test card values');
  await user.selectOptions(selector, 'upi_custom');
  await user.type(screen.getByLabelText('Test UPI ID'), 'person@bank');
  await user.click(submit);
  expect(screen.getByRole('alert')).toHaveTextContent('Use only the displayed test UPI ID');
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/rides'))).toHaveLength(0);
});

it.each(['card_visa', 'card_mastercard', 'card_rupay', 'card_amex', 'upi_custom'])('books %s using dummy input without transmitting it', async payment => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => String(url).endsWith('/quotes')
    ? response(quote, 201)
    : response({id: 'ride1', quote_id: 'q1', pickup, destination, vehicle, payment}, 201));
  const user = userEvent.setup();
  render(<Booking token="secret" destination={destination} onBack={() => {}} />);
  await user.selectOptions(await screen.findByLabelText('Payment method'), payment);
  if (payment === 'upi_custom') {
    await user.type(screen.getByLabelText('Test UPI ID'), 'test@example.invalid');
  } else {
    await user.type(screen.getByLabelText('Test card number'), '0000000000000000');
    await user.type(screen.getByLabelText('Test expiry'), '00/00');
    await user.type(screen.getByLabelText('Test CVV'), '000');
  }
  await user.click(screen.getByRole('button', {name: /Confirm simulated booking/}));
  expect(await screen.findByText('Your Ride is Confirmed!', {}, {timeout: 2500})).toBeInTheDocument();
  expect(screen.queryByLabelText('Test card number')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Test UPI ID')).not.toBeInTheDocument();
  const call = fetcher.mock.calls.find(([url]) => String(url).endsWith('/rides'));
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({quote_id: 'q1', vehicle: 'bike', payment});
});
