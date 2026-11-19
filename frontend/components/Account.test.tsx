// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Account from './Account';

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

it('renders hostile stored profile and saved place content as inert text', async () => {
  const firstName = '<img src=x onerror="window.profileAttack=1">';
  const lastName = '<script>window.profileAttack=2</script>';
  const label = '<svg onload="window.placeAttack=1">';
  const name = '<img src=x onerror="window.placeAttack=2">';
  localStorage.setItem('ridenow_session', 'token');
  vi.spyOn(globalThis, 'fetch').mockImplementation(url => {
    const path = String(url);
    const body = path.endsWith('/profile')
      ? {id: '1', first_name: firstName, last_name: lastName, phone: '', email: '', photo: '', rating: 5, method: 'email'}
      : path.endsWith('/wallet') ? {balance_paise: 0}
      : path.endsWith('/saved') ? {items: [{id: 'p1', label, name, lat: 0, lng: 0}], total: 1}
      : {items: [], total: 0};
    return Promise.resolve(new Response(JSON.stringify(body), {status: 200}));
  });
  const {container} = render(<Account />);
  expect(await screen.findByDisplayValue(firstName)).toBeInTheDocument();
  expect(screen.getByDisplayValue(lastName)).toBeInTheDocument();
  const profile = screen.getByText(`${firstName} ${lastName} · ★ 5.00`);
  expect(profile).toHaveTextContent(firstName);
  const places = screen.getByRole('heading', {name: 'Saved places'}).parentElement!;
  expect(within(places).getByText(label)).toBeInTheDocument();
  expect(places).toHaveTextContent(name);
  expect(container.querySelector('script, svg, img')).toBeNull();
  expect((window as unknown as Record<string, unknown>).profileAttack).toBeUndefined();
  expect((window as unknown as Record<string, unknown>).placeAttack).toBeUndefined();
});

const initialProfile = {id: '1', first_name: 'Asha', last_name: 'Rao', phone: '+919876543210', email: 'asha@example.com', photo: '', rating: 4.8, method: 'email'};
const location = {name: 'Cyber Towers', lat: 17.45, lng: 78.38};

function accountServer() {
  let profile = {...initialProfile};
  let balance = 1250;
  let saved: Array<typeof location & {id: string; label: string}> = [];
  let failProfileLoad = false;
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    const path = String(url);
    const method = init?.method || 'GET';
    let body: unknown;
    if (path.endsWith('/profile') && method === 'PUT') {
      profile = {...profile, ...JSON.parse(String(init?.body))}; body = profile;
    } else if (path.endsWith('/profile')) {
      if (failProfileLoad) return Promise.resolve(new Response(JSON.stringify({detail: 'Account unavailable'}), {status: 503}));
      body = profile;
    } else if (path.endsWith('/wallet/funds')) {
      balance += JSON.parse(String(init?.body)).amount_paise; body = {balance_paise: balance};
    } else if (path.endsWith('/wallet')) body = {balance_paise: balance};
    else if (path.includes('/search?')) body = {items: [location], total: 1};
    else if (path.endsWith('/saved') && method === 'PUT') {
      const place = {...JSON.parse(String(init?.body)), id: 'p1'};
      saved = [place]; body = place;
    } else if (path.endsWith('/saved/p1') && method === 'DELETE') {
      saved = []; return Promise.resolve(new Response(null, {status: 204}));
    } else if (path.endsWith('/saved')) body = {items: saved, total: saved.length};
    else throw new Error(`Unexpected request: ${method} ${path}`);
    return Promise.resolve(new Response(JSON.stringify(body), {status: 200}));
  });
  return {fetchMock, setLoadFailure: (value: boolean) => {failProfileLoad = value;}};
}

it('loads and updates a normal account, wallet, appearance and saved place', async () => {
  localStorage.setItem('ridenow_session', 'token');
  const {fetchMock} = accountServer();
  const user = userEvent.setup();
  render(<Account />);
  expect(await screen.findByDisplayValue('Asha')).toBeInTheDocument();
  expect(screen.getByText('Asha Rao · ★ 4.80')).toBeInTheDocument();
  expect(screen.getByText(/Simulated balance: ₹12.50/)).toBeInTheDocument();
  await user.clear(screen.getByLabelText('First name'));
  await user.type(screen.getByLabelText('First name'), 'Anita');
  await user.click(screen.getByRole('button', {name: 'Save profile'}));
  expect(await screen.findByText('Profile saved.')).toBeInTheDocument();
  expect(screen.getByText('Anita Rao · ★ 4.80')).toBeInTheDocument();
  const put = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/profile') && init?.method === 'PUT');
  expect(JSON.parse(String(put?.[1]?.body))).toEqual({first_name: 'Anita', last_name: 'Rao', phone: '+919876543210', email: 'asha@example.com', photo: ''});
  expect(new Headers(put?.[1]?.headers).get('Authorization')).toBe('Bearer token');
  await user.clear(screen.getByLabelText('Amount in rupees'));
  await user.type(screen.getByLabelText('Amount in rupees'), '20.25');
  await user.click(screen.getByRole('button', {name: 'Add mock funds'}));
  expect(await screen.findByText('Simulated funds added.')).toBeInTheDocument();
  expect(screen.getByText(/Simulated balance: ₹32.75/)).toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText('Theme'), 'dark');
  expect(localStorage.getItem('ridenow_theme')).toBe('dark');
  await user.click(screen.getByRole('button', {name: 'Save place'}));
  expect(await screen.findByText('Place saved.')).toBeInTheDocument();
  expect(screen.getByRole('button', {name: 'Remove Home'}).parentElement).toHaveTextContent('Cyber Towers');
  await user.click(screen.getByRole('button', {name: 'Remove Home'}));
  expect(await screen.findByText('Place removed.')).toBeInTheDocument();
  expect(screen.getByText(/No saved places yet/)).toBeInTheDocument();
});

it.each([
  ['unsupported type', new File(['x'], 'image.gif', {type: 'image/gif'})],
  ['oversized image', new File([new Uint8Array(140001)], 'large.png', {type: 'image/png'})],
])('rejects %s and recovers via Retry without saving a photo', async (_case, file) => {
  localStorage.setItem('ridenow_session', 'token');
  const {fetchMock} = accountServer();
  const user = userEvent.setup({applyAccept: false});
  render(<Account />);
  const input = await screen.findByLabelText(/Profile photo/);
  await user.upload(input, file);
  expect(screen.getByRole('alert')).toHaveTextContent('Choose a PNG, JPEG or WebP under 140 KB.');
  expect(screen.queryByRole('img', {name: 'Profile'})).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/profile') && init?.method === 'PUT')).toBe(false);
  await user.click(screen.getByRole('button', {name: 'Retry'}));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(await screen.findByDisplayValue('Asha')).toBeInTheDocument();
});

it('previews a supported photo, saves its data URL, and removes it', async () => {
  localStorage.setItem('ridenow_session', 'token');
  const {fetchMock} = accountServer();
  const user = userEvent.setup();
  render(<Account />);
  await user.upload(await screen.findByLabelText(/Profile photo/), new File(['hello'], 'avatar.png', {type: 'image/png'}));
  expect(await screen.findByRole('img', {name: 'Profile'})).toHaveAttribute('src', 'data:image/png;base64,aGVsbG8=');
  await user.click(screen.getByRole('button', {name: 'Save profile'}));
  expect(await screen.findByText('Profile saved.')).toBeInTheDocument();
  const put = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/profile') && init?.method === 'PUT');
  expect(JSON.parse(String(put?.[1]?.body)).photo).toBe('data:image/png;base64,aGVsbG8=');
  await user.click(screen.getByRole('button', {name: 'Remove photo'}));
  expect(screen.queryByRole('img', {name: 'Profile'})).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', {name: 'Save profile'}));
  expect(await screen.findByText('Profile saved.')).toBeInTheDocument();
  const puts = fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/profile') && init?.method === 'PUT');
  expect(JSON.parse(String(puts[1][1]?.body)).photo).toBe('');
});

it('shows a file read failure and recovers by retrying and uploading another image', async () => {
  localStorage.setItem('ridenow_session', 'token');
  accountServer();
  const user = userEvent.setup();
  const read = vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) {
    this.dispatchEvent(new ProgressEvent('error'));
  });
  render(<Account />);
  await user.upload(await screen.findByLabelText(/Profile photo/), new File(['bad'], 'bad.png', {type: 'image/png'}));
  expect(screen.getByRole('alert')).toHaveTextContent('Could not read this photo.');
  expect(screen.queryByRole('img', {name: 'Profile'})).not.toBeInTheDocument();
  read.mockRestore();
  await user.click(screen.getByRole('button', {name: 'Retry'}));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  await user.upload(screen.getByLabelText(/Profile photo/), new File(['good'], 'good.webp', {type: 'image/webp'}));
  expect(await screen.findByRole('img', {name: 'Profile'})).toHaveAttribute('src', 'data:image/webp;base64,Z29vZA==');
});

it('clears an invalid photo alert after a valid upload without Retry', async () => {
  localStorage.setItem('ridenow_session', 'token');
  accountServer();
  const user = userEvent.setup({applyAccept: false});
  render(<Account />);
  const input = await screen.findByLabelText(/Profile photo/);
  await user.upload(input, new File(['bad'], 'bad.gif', {type: 'image/gif'}));
  expect(screen.getByRole('alert')).toHaveTextContent('Choose a PNG, JPEG or WebP under 140 KB.');
  await user.upload(input, new File(['good'], 'good.png', {type: 'image/png'}));
  expect(await screen.findByRole('img', {name: 'Profile'})).toHaveAttribute('src', 'data:image/png;base64,Z29vZA==');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('clears a photo read error after a valid upload without Retry', async () => {
  localStorage.setItem('ridenow_session', 'token');
  accountServer();
  const user = userEvent.setup();
  const read = vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) {
    this.dispatchEvent(new ProgressEvent('error'));
  });
  render(<Account />);
  const input = await screen.findByLabelText(/Profile photo/);
  await user.upload(input, new File(['bad'], 'bad.png', {type: 'image/png'}));
  expect(screen.getByRole('alert')).toHaveTextContent('Could not read this photo.');
  read.mockRestore();
  await user.upload(input, new File(['good'], 'good.webp', {type: 'image/webp'}));
  expect(await screen.findByRole('img', {name: 'Profile'})).toHaveAttribute('src', 'data:image/webp;base64,Z29vZA==');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('preserves an unrelated alert after a valid photo upload', async () => {
  localStorage.setItem('ridenow_session', 'token');
  accountServer();
  const user = userEvent.setup();
  render(<Account />);
  const input = await screen.findByLabelText(/Profile photo/);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
  await user.selectOptions(screen.getByLabelText('Theme'), 'dark');
  expect(screen.getByRole('alert')).toHaveTextContent('Could not save appearance on this device.');
  await user.upload(input, new File(['good'], 'good.png', {type: 'image/png'}));
  expect(await screen.findByRole('img', {name: 'Profile'})).toHaveAttribute('src', 'data:image/png;base64,Z29vZA==');
  expect(screen.getByRole('alert')).toHaveTextContent('Could not save appearance on this device.');
});

it('retries an initial account load failure', async () => {
  localStorage.setItem('ridenow_session', 'token');
  const server = accountServer(); server.setLoadFailure(true);
  const user = userEvent.setup();
  render(<Account />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Account unavailable');
  server.setLoadFailure(false);
  await user.click(screen.getByRole('button', {name: 'Retry'}));
  expect(await screen.findByDisplayValue('Asha')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
