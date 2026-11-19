// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Search from './Search';

vi.mock('next/dynamic', () => ({default: () => function TestMap({onSelect}: {onSelect: (place: {name: string; lat: number; lng: number}) => void}) { return <button onClick={() => onSelect({name: 'Map pin', lat: 17.44, lng: 78.38})}>Select map pin</button>; }}));
const airport = {name: 'Rajiv Gandhi International Airport (RGIA), Shamshabad', lat: 17.2403, lng: 78.4294};
const response = (body: unknown, status = 200) => Promise.resolve(new Response(status === 204 ? null : JSON.stringify(body), {status}));
beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

describe('Hyderabad search', () => {
  it('searches using the bearer session, saves a place, and restores recents', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      const path = String(url);
      if (init?.method === 'PUT') return response({...JSON.parse(String(init.body)), id: '1'});
      if (path.includes('/saved')) return response({items: [], total: 0});
      return response({items: [airport], total: 1});
    });
    const user = userEvent.setup(); const view = render(<Search token="secret" onAccount={() => {}} />);
    await user.type(screen.getByLabelText('Search Hyderabad'), 'RGIA');
    await user.click(await screen.findByRole('button', {name: /Rajiv Gandhi International Airport/i}));
    expect(screen.getByText('17.24030, 78.42940')).toBeInTheDocument();
    await user.click(screen.getByRole('button', {name: 'Save place'}));
    expect(await screen.findByText('Home saved.')).toBeInTheDocument();
    expect(fetcher.mock.calls.some(([url, init]) => String(url).includes('q=RGIA') && new Headers(init?.headers).get('Authorization') === 'Bearer secret')).toBe(true);
    expect(JSON.parse(localStorage.getItem('ridenow_recent_locations') || '[]')[0]).toEqual(airport);
    view.unmount(); render(<Search token="secret" onAccount={() => {}} />);
    expect(await screen.findByText('Recent searches')).toBeInTheDocument();
  });

  it('surfaces failures, retries and accepts a custom pin', async () => {
    let fail = true;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => fail ? Promise.reject(new Error('offline')) : response({items: [], total: 0}));
    const user = userEvent.setup(); render(<Search token="secret" onAccount={() => {}} />);
    await screen.findByRole('button', {name: /^Retry$/});
    fail = false; await user.click(screen.getByRole('button', {name: /^Retry$/}));
    expect(await screen.findByText(/No places found/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', {name: 'Select map pin'}));
    expect(screen.getByText('17.44000, 78.38000')).toBeInTheDocument();
  });

  it('preselects parcel after navigation and retains it while choosing a destination', async () => {
    window.history.replaceState({}, '', '/?service=parcel');
    const parcel = {id: 'parcel', name: 'Parcel', seats: null, tier_fee: 0, eta_minutes: 3, base_fare: 30, original_fare: 30, fare: 30};
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => String(url).includes('/quotes')
      ? response({id: 'q', pickup: {name: 'Pickup', lat: 17.44, lng: 78.38}, destination: airport, distance_km: 20, surge_multiplier: 1, vehicles: [parcel]})
      : String(url).includes('/saved') ? response({items: [], total: 0}) : response({items: [airport], total: 1}));
    const user = userEvent.setup(); render(<Search token="secret" onAccount={() => {}} />);
    await user.click(await screen.findByRole('button', {name: /Rajiv Gandhi International Airport/i}));
    await user.click(screen.getByRole('button', {name: 'Compare rides'}));
    expect(await screen.findByRole('radio', {name: /Parcel/})).toBeChecked();
    expect(screen.getByLabelText('Recipient name')).toBeInTheDocument();
    window.history.replaceState({}, '', '/');
  });

  it('rebooks valid stored routes and rejects malformed route coordinates', async () => {
    const pickup = {name: 'Cyber Towers', lat: 17.45, lng: 78.38};
    const bike = {id: 'bike', name: 'Bike', seats: 1, tier_fee: 0, eta_minutes: 3, base_fare: 30, original_fare: 30, fare: 30};
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(url => String(url).includes('/quotes')
      ? response({id: 'q', pickup, destination: airport, distance_km: 20, surge_multiplier: 1, vehicles: [bike]})
      : response({items: [], total: 0}));
    localStorage.setItem('ridenow_rebook', JSON.stringify({token: 'secret', pickup, destination: airport}));
    const view = render(<Search token="secret" onAccount={() => {}} />);
    expect(await screen.findByText('Choose a ride')).toBeInTheDocument();
    await waitFor(() => expect(fetcher.mock.calls.some(([url, init]) => String(url).includes('/quotes') && JSON.parse(String(init?.body)).pickup.name === 'Cyber Towers')).toBe(true));
    expect(localStorage.getItem('ridenow_rebook')).toBeNull();
    view.unmount(); localStorage.setItem('ridenow_rebook', JSON.stringify({token: 'secret', pickup: {name: 'bad'}, destination: airport}));
    render(<Search token="secret" onAccount={() => {}} />);
    expect(await screen.findByText('The saved rebook route could not be read.')).toBeInTheDocument();
    expect(localStorage.getItem('ridenow_rebook')).toBeNull();
  });
});
