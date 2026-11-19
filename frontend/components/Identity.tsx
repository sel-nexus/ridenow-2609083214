'use client';

import React, { useEffect, useState, type FormEvent } from 'react';
import { api, type Profile, type Session } from '../lib/api';
import Search from './Search';

const SESSION_KEY = 'ridenow_session';
type Method = 'google' | 'apple' | 'guest';

/** Present explicitly simulated entry and an editable persisted profile. */
export default function Identity() {
  const [token, setToken] = useState('');
  const [showHome, setShowHome] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [country, setCountry] = useState('+91');
  const [phone, setPhone] = useState('');
  const [challenge, setChallenge] = useState('');
  const [otp, setOtp] = useState('');
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const stored = localStorage.getItem(SESSION_KEY);
    if (!stored) { setRestoring(false); return; }
    api<Profile>('/profile', {}, stored).then(p => { setToken(stored); setProfile(p); }).catch((e: Error) => { setError(e.message); }).finally(() => setRestoring(false));
  }, []);
  useEffect(() => {
    if (!seconds) return;
    const timer = window.setTimeout(() => setSeconds(seconds - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [seconds]);

  async function perform(action: () => Promise<void>) {
    setError(''); setNotice(''); setBusy(true);
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong.'); }
    finally { setBusy(false); }
  }
  function accept(session: Session) {
    localStorage.setItem(SESSION_KEY, session.token); setToken(session.token); setProfile(session.profile); setChallenge('');
  }
  async function start() {
    const digits = phone.replace(/[\s()-]/g, '');
    if (!/^[0-9]{7,14}$/.test(digits)) throw new Error('Enter a valid phone number using digits.');
    const result = await api<{challenge: string}>('/phone/start', { method: 'POST', body: JSON.stringify({phone: country + digits}) });
    setChallenge(result.challenge); setOtp(''); setSeconds(30); setNotice('Simulation only: no SMS was sent. Enter any 4 or 6 digits.');
  }
  function entry(method: Method) {
    void perform(async () => accept(await api<Session>('/enter', {method: 'POST', body: JSON.stringify({method})})));
  }
  function change(field: keyof Profile, value: string) {
    setProfile(p => p ? {...p, [field]: value} : p);
  }
  function upload(file: File | undefined) {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 140000) { setError('Choose a PNG, JPEG or WebP photo under 140 KB.'); return; }
    const reader = new FileReader();
    reader.onload = () => change('photo', String(reader.result));
    reader.onerror = () => setError('Could not read this photo.');
    reader.readAsDataURL(file);
  }
  if (restoring) return <main className="loading" role="status">Restoring your session…</main>;
  if (profile && showHome) return <Search token={token} onAccount={() => setShowHome(false)} />;
  return <main className="page">
    <header className="topbar"><span className="brand">RideNow<span className="brand-dot">.</span></span><span className="location">HYDERABAD, INDIA</span></header>
    <div className="layout"><section className="intro" aria-labelledby="intro-title"><div className="eyebrow"><span className="live-dot"/> YOUR CITY, IN MOTION</div><h1 id="intro-title">A little closer<br/>to <em>everywhere.</em></h1><p>From the everyday to the extraordinary. Your Hyderabad journey starts here.</p><div className="route-art" aria-hidden="true"><div className="route-line"/><span className="route-start"/><span className="route-end"/><span className="route-label start">HITEC CITY</span><span className="route-label end">YOUR NEXT STOP</span></div><p className="simulation">A mobility simulation. No rides, messages or payments are real.</p></section>
    <section className="card" aria-label={profile ? 'Your profile' : 'Get started'}>
      {error && <div className="alert" role="alert">{error}</div>}{notice && <div className="notice" role="status">{notice}</div>}
      {profile ? <><div className="card-kicker">YOUR RIDER PROFILE</div><h2>Good to see you,<br/>{profile.first_name}.</h2><div className="profile-summary">{profile.photo ? <img src={profile.photo} alt="Profile" /> : <span className="avatar" aria-hidden="true">{profile.first_name.charAt(0).toUpperCase()}</span>}<div><strong>{profile.first_name} {profile.last_name}</strong><span className="rating">★ {profile.rating.toFixed(2)} rider rating · {profile.method} demo</span></div></div>
        <button className="primary" type="button" onClick={() => setShowHome(true)}>Go to Home <span aria-hidden="true">→</span></button>
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); void perform(async () => { const {first_name, last_name, phone: p, email, photo} = profile; const updated = await api<Profile>('/profile', {method: 'PUT', body: JSON.stringify({first_name, last_name, phone: p, email, photo})}, token); setProfile(updated); setNotice('Profile saved.'); }); }}>
          <div className="field-row"><label>First name<input required maxLength={60} value={profile.first_name} onChange={e => change('first_name', e.target.value)} /></label><label>Last name<input maxLength={60} value={profile.last_name} onChange={e => change('last_name', e.target.value)} /></label></div>
          <label>Phone <span className="hint">international format</span><input type="tel" value={profile.phone} onChange={e => change('phone', e.target.value)} placeholder="+919876543210" /></label>
          <label>Email<input type="email" value={profile.email} onChange={e => change('email', e.target.value)} placeholder="you@example.com" /></label>
          <label>Profile photo <span className="hint">PNG, JPEG or WebP, under 140 KB</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => upload(e.target.files?.[0])}/></label>
          {profile.photo && <button className="text-button" type="button" onClick={() => change('photo', '')}>Remove photo</button>}
          <button className="primary" disabled={busy}>Save profile <span aria-hidden="true">→</span></button>
        </form><button className="text-button signout" disabled={busy} onClick={() => void perform(async () => { await api<void>('/logout', {method: 'POST'}, token); localStorage.removeItem(SESSION_KEY); setToken(''); setProfile(null); setNotice('Signed out of this demo session.'); })}>Sign out</button></> : <><div className="card-kicker">WELCOME TO RIDENOW</div><h2>{challenge ? 'Enter your code' : 'Let’s get moving.'}</h2><p className="card-copy">{challenge ? `Your simulated code for ${country} ${phone}` : 'Enter your phone number to get started.'}</p>
        {challenge ? <form onSubmit={e => { e.preventDefault(); void perform(async () => { if (!/^(?:[0-9]{4}|[0-9]{6})$/.test(otp)) throw new Error('Enter 4 or 6 digits.'); accept(await api<Session>('/phone/verify', {method: 'POST', body: JSON.stringify({challenge, otp})})); }); }}><label>Verification code<input autoComplete="one-time-code" inputMode="numeric" value={otp} onChange={e => setOtp(e.target.value)} placeholder="4 or 6 digits" required /></label><p className="small">No SMS is sent. Any 4 or 6 digits work in this simulation.</p><button className="primary" disabled={busy}>Continue <span aria-hidden="true">→</span></button><button type="button" className="text-button" disabled={busy || seconds > 0} onClick={() => void perform(start)}>{seconds ? `Resend in ${seconds}s` : 'Resend simulated code'}</button><button type="button" className="text-button" onClick={() => {setChallenge(''); setError('');}}>Change number</button></form> : <><form onSubmit={e => {e.preventDefault(); void perform(start);}}><label htmlFor="phone">Phone number</label><div className="phone-row"><label className="sr-only" htmlFor="country">Country code</label><select id="country" value={country} onChange={e => setCountry(e.target.value)}><option value="+91">IN +91</option><option value="+1">US +1</option><option value="+44">UK +44</option><option value="+61">AU +61</option></select><input id="phone" type="tel" autoComplete="tel-national" required value={phone} onChange={e => setPhone(e.target.value)} placeholder="98765 43210" /></div><button className="primary" disabled={busy}>Continue with phone <span aria-hidden="true">→</span></button></form><div className="divider"><span>or continue with</span></div><div className="social"><button disabled={busy} onClick={() => entry('google')}>Google</button><button disabled={busy} onClick={() => entry('apple')}>Apple</button></div><button className="guest" disabled={busy} onClick={() => entry('guest')}>Continue as guest <span aria-hidden="true">→</span></button><p className="small">All sign-in options are simulated. Google and Apple are not contacted, and no phone number is verified.</p></>}</>}
    </section></div><footer>RIDENOW <span>MADE FOR HYDERABAD</span></footer>
  </main>;
}
