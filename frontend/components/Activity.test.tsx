// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Activity from './Activity';
import Account from './Account';

const response = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}}));
afterEach(() => {cleanup(); vi.restoreAllMocks(); localStorage.clear();});

it('shows empty activity and communicates service failures', async () => {
  localStorage.setItem('ridenow_session', 'token');
  vi.spyOn(globalThis, 'fetch').mockImplementation(url => String(url).includes('/history') ? response({items: [], total: 0}) : String(url).includes('/schedules') ? response({items: [], total: 0}) : response({items: [], total: 0}));
  render(<Activity />);
  expect(await screen.findByText('No completed journeys yet.')).toBeInTheDocument();
  expect(screen.getByText('No upcoming reservations.')).toBeInTheDocument();
});

it('shows an actionable error instead of inventing history', async () => {
  localStorage.setItem('ridenow_session', 'token');
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
  render(<Activity />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to reach');
  expect(screen.getByRole('button', {name: 'Retry'})).toBeInTheDocument();
});

it('adds mock wallet funds and persists the selected theme', async () => {
  localStorage.setItem('ridenow_session', 'token');
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    const path = String(url);
    if (path.includes('/profile')) return response({id: 'a', first_name: 'Guest', last_name: '', email: '', phone: '', photo: '', rating: 4.92, method: 'guest'});
    if (path.includes('/wallet/funds') && init?.method === 'POST') return response({balance_paise: 10000});
    if (path.includes('/wallet')) return response({balance_paise: 0});
    return response({items: [], total: 0});
  });
  const user = userEvent.setup(); render(<Account />);
  await user.click(await screen.findByRole('button', {name: 'Add mock funds'}));
  expect(await screen.findByText(/Simulated balance: ₹100.00/)).toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText('Theme'), 'dark');
  expect(localStorage.getItem('ridenow_theme')).toBe('dark');
});
