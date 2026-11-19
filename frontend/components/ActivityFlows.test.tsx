// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Activity from './Activity';
import Account from './Account';

const response = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), {status}));
const ride = {id: 'ride1', quote_id: 'q1', pickup: {name: 'Cyber Towers', lat: 17.45, lng: 78.38}, destination: {name: 'Airport', lat: 17.24, lng: 78.43}, distance_km: 20, surge_multiplier: 1, vehicle: {id: 'bike', name: 'Bike', seats: 1, tier_fee: 0, eta_minutes: 3, base_fare: 30, original_fare: 30, fare: 30}, payment: 'cash', status: 'completed', created_at: '2025-01-01T00:00:00Z', parcel: null, feedback: null};
const receipt = {...ride, breakdown: {base_and_distance: 30, tier_fee: 0, time: 0, surge: 0, discount: 0, total: 30}};
afterEach(() => {cleanup(); vi.restoreAllMocks(); localStorage.clear();});

it('caches history and viewed receipts for offline retrieval only, labelled stale', async () => {
  localStorage.setItem('ridenow_session', 'token');
  let offline = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation(url => {
    if (offline) return Promise.reject(new TypeError('offline'));
    const path = String(url);
    if (path.endsWith('/history/ride1')) return response(receipt);
    if (path.includes('/history')) return response({items: [ride], total: 1});
    return response({items: [], total: 0});
  });
  const user = userEvent.setup(); const view = render(<Activity />);
  await user.click(await screen.findByRole('button', {name: 'View receipt'}));
  expect(await screen.findByRole('heading', {name: 'Receipt · Bike'})).toBeInTheDocument();
  view.unmount(); offline = true; render(<Activity />);
  expect(await screen.findByText(/Offline: showing previously cached history/)).toHaveTextContent('stale');
  expect(screen.queryByText('Upcoming reservations')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', {name: 'View receipt'}));
  expect(await screen.findByRole('heading', {name: 'Receipt · Bike'})).toBeInTheDocument();
  expect(screen.queryByRole('button', {name: 'Save feedback'})).not.toBeInTheDocument();
});

it('does not expose another session cache or use cache for an authorization error', async () => {
  localStorage.setItem('ridenow_session', 'token');
  vi.spyOn(globalThis, 'fetch').mockImplementation(url => String(url).includes('/history') ? response({items: [ride], total: 1}) : response({items: [], total: 0}));
  const view = render(<Activity />); await screen.findByText('Cyber Towers → Airport'); view.unmount();
  vi.mocked(fetch).mockImplementation(() => response({}, 401));
  render(<Activity />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Session or challenge expired');
  expect(screen.queryByText('Cyber Towers → Airport')).not.toBeInTheDocument();
  cleanup(); localStorage.setItem('ridenow_session', 'another-token');
  vi.mocked(fetch).mockRejectedValue(new TypeError('offline'));
  render(<Activity />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to reach');
  expect(screen.queryByText('Cyber Towers → Airport')).not.toBeInTheDocument();
});

it('saves account profile and saved place, and displays API failures', async () => {
  localStorage.setItem('ridenow_session', 'token');
  const place = {name: 'Cyber Towers', lat: 17.45, lng: 78.38};
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    const path = String(url);
    if (path.endsWith('/profile')) return response({id: 'a', first_name: init?.method === 'PUT' ? 'Asha' : 'Guest', last_name: '', email: '', phone: '', photo: '', rating: 4.92, method: 'guest'});
    if (path.includes('/wallet')) return response({balance_paise: 0});
    if (path.endsWith('/saved') && init?.method === 'PUT') return response({...place, id: 'p1', label: 'Home'});
    if (path.includes('/saved/')) return response({detail: 'Cannot remove place'}, 500);
    return response(path.includes('/search') ? {items: [place], total: 1} : {items: [], total: 0});
  });
  const user = userEvent.setup(); render(<Account />);
  const name = await screen.findByLabelText('First name'); await user.clear(name); await user.type(name, 'Asha');
  await user.click(screen.getByRole('button', {name: 'Save profile'}));
  expect(await screen.findByText('Profile saved.')).toBeInTheDocument();
  await user.click(screen.getByRole('button', {name: 'Save place'}));
  expect(await screen.findByText('Place saved.')).toBeInTheDocument();
  await user.click(screen.getByRole('button', {name: 'Remove Home'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Cannot remove place');
  expect(screen.getByRole('button', {name: 'Remove Home'})).toBeInTheDocument();
});

it('links Packages to parcel selection', async () => {
  localStorage.setItem('ridenow_session', 'token');
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => response({items: [], total: 0}));
  render(<Activity mode="services" />);
  expect(await screen.findByRole('link', {name: 'Packages'})).toHaveAttribute('href', '/?service=parcel');
});
