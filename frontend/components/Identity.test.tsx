// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Identity from './Identity';

const profile = {id: 'one', first_name: 'Guest', last_name: '', phone: '', email: '', photo: '', rating: 4.92, method: 'guest'};
const reply = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}}));

afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });
beforeEach(() => { localStorage.clear(); });

describe('simulated identity', () => {
  it('starts a simulated challenge and rejects malformed OTP', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(() => reply({challenge: 'challenge-token'}));
    const user = userEvent.setup(); render(<Identity />);
    await user.type(await screen.findByLabelText('Phone number'), '9876543210');
    await user.click(screen.getByRole('button', {name: /continue with phone/i}));
    expect(await screen.findByText(/no SMS was sent/i)).toBeTruthy();
    expect(fetcher.mock.calls[0][0]).toBe('/api/v1/identity/phone/start');
    await user.type(screen.getByLabelText('Verification code'), 'abc');
    await user.click(screen.getByRole('button', {name: /^continue$/i}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter 4 or 6 digits');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('persists a guest session, saves profile and restores it', async () => {
    let saved = profile;
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      if (String(url).endsWith('/enter')) return reply({token: 'session-token', profile});
      if (init?.method === 'PUT') { saved = {...profile, ...JSON.parse(String(init.body))}; return reply(saved); }
      return reply(saved);
    });
    const user = userEvent.setup(); const view = render(<Identity />);
    await user.click(await screen.findByRole('button', {name: /continue as guest/i}));
    expect(await screen.findByText(/4.92 rider rating/i)).toBeTruthy();
    const name = screen.getByLabelText('First name'); await user.clear(name); await user.type(name, 'Asha');
    await user.click(screen.getByRole('button', {name: /save profile/i}));
    expect(await screen.findByText('Profile saved.')).toBeTruthy();
    expect(localStorage.getItem('ridenow_session')).toBe('session-token');
    view.unmount(); render(<Identity />);
    await waitFor(() => expect(screen.getByDisplayValue('Asha')).toBeTruthy());
  });

  it('uploads a photo, saves it, and restores the saved photo in a new session view', async () => {
    let saved = profile;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      if (String(url).endsWith('/enter')) return reply({token: 'session-token', profile});
      if (init?.method === 'PUT') { saved = {...profile, ...JSON.parse(String(init.body))}; return reply(saved); }
      return reply(saved);
    });
    const user = userEvent.setup(); const view = render(<Identity />);
    await user.click(await screen.findByRole('button', {name: /continue as guest/i}));
    const file = new File(['photo data'], 'photo.png', {type: 'image/png'});
    await user.upload(screen.getByLabelText(/profile photo/i), file);
    const photo = await screen.findByRole('img', {name: 'Profile'});
    const dataUrl = 'data:image/png;base64,cGhvdG8gZGF0YQ==';
    expect(photo).toHaveAttribute('src', dataUrl);
    expect(screen.getByRole('button', {name: /remove photo/i})).toBeInTheDocument();
    await user.click(screen.getByRole('button', {name: /save profile/i}));
    expect(await screen.findByText('Profile saved.')).toBeInTheDocument();
    const put = fetcher.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(put?.[1]?.body)).photo).toBe(dataUrl);
    view.unmount(); render(<Identity />);
    expect(await screen.findByRole('img', {name: 'Profile'})).toHaveAttribute('src', dataUrl);
  });

  it.each([
    ['unsupported type', new File(['text'], 'photo.txt', {type: 'text/plain'})],
    ['oversized image', new File([new Uint8Array(140001)], 'large.png', {type: 'image/png'})],
  ])('rejects an %s without replacing the existing photo', async (_description, file) => {
    const originalPhoto = 'data:image/png;base64,b2xk';
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => reply({token: 'session-token', profile: {...profile, photo: originalPhoto}}));
    const user = userEvent.setup({applyAccept: false}); render(<Identity />);
    await user.click(await screen.findByRole('button', {name: /continue as guest/i}));
    await user.upload(screen.getByLabelText(/profile photo/i), file);
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a PNG, JPEG or WebP photo under 140 KB.');
    expect(screen.getByRole('img', {name: 'Profile'})).toHaveAttribute('src', originalPhoto);
  });

  it('reports a FileReader error and recovers when a later photo is readable', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => reply({token: 'session-token', profile}));
    const read = vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementationOnce(function (this: FileReader) {
      this.onerror?.(new ProgressEvent('error') as ProgressEvent<FileReader>);
    });
    const user = userEvent.setup(); render(<Identity />);
    await user.click(await screen.findByRole('button', {name: /continue as guest/i}));
    await user.upload(screen.getByLabelText(/profile photo/i), new File(['bad'], 'bad.png', {type: 'image/png'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read this photo.');
    expect(screen.queryByRole('img', {name: 'Profile'})).not.toBeInTheDocument();
    read.mockRestore();
    await user.upload(screen.getByLabelText(/profile photo/i), new File(['good'], 'good.png', {type: 'image/png'}));
    expect(await screen.findByRole('img', {name: 'Profile'})).toHaveAttribute('src', 'data:image/png;base64,Z29vZA==');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows network failure without inventing a session', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    render(<Identity />); const user = userEvent.setup();
    await user.click(await screen.findByRole('button', {name: 'Google'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to reach');
    expect(localStorage.getItem('ridenow_session')).toBeNull();
  });
});
