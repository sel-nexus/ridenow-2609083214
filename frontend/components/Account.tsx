'use client';

import React, { useEffect, useState } from 'react';
import { api, type Location, type LocationPage, type Profile, type SavedPlace } from '../lib/api';

/** Manage the existing profile, simulated credits, theme, and saved places. */
export default function Account() {
  const [token, setToken] = useState('');
  const [ready, setReady] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [balance, setBalance] = useState(0);
  const [amount, setAmount] = useState('100');
  const [theme, setTheme] = useState('system');
  const [saved, setSaved] = useState<SavedPlace[]>([]);
  const [places, setPlaces] = useState<Location[]>([]);
  const [place, setPlace] = useState('0');
  const [label, setLabel] = useState('Home');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  async function load(t: string) {
    const [p, w, s, locations] = await Promise.all([api<Profile>('/profile', {}, t), api<{balance_paise: number}>('/wallet', {}, t, 'activity'), api<LocationPage<SavedPlace>>('/saved', {}, t, 'locations'), api<LocationPage<Location>>('/search?limit=50', {}, t, 'locations')]);
    setProfile(p); setBalance(w.balance_paise); setSaved(s.items); setPlaces(locations.items);
  }
  useEffect(() => {
    const t = localStorage.getItem('ridenow_session') || ''; setToken(t); setTheme(localStorage.getItem('ridenow_theme') || 'system');
    if (!t) { setReady(true); return; }
    load(t).catch(e => setError(e instanceof Error ? e.message : 'Could not load account.')).finally(() => setReady(true));
  }, []);
  async function perform(action: () => Promise<void>) {
    setError(''); setNotice(''); setBusy(true);
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : 'Please try again.'); } finally {setBusy(false);}
  }
  function change(field: keyof Profile, value: string) { setProfile(p => p ? {...p, [field]: value} : p); }
  function photo(file?: File) {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 140000) {setError('Choose a PNG, JPEG or WebP under 140 KB.'); return;}
    const reader = new FileReader(); reader.onload = () => change('photo', String(reader.result)); reader.onerror = () => setError('Could not read this photo.'); reader.readAsDataURL(file);
  }
  if (!ready) return <main className="feature-page" role="status">Loading account…</main>;
  if (!token) return <main className="feature-page"><h1>Sign in to continue</h1><a href="/">Go to sign in</a></main>;
  return <main className="feature-page"><div className="card-kicker">YOUR RIDER ACCOUNT</div><h1>Account</h1>{error && <div role="alert" className="alert">{error} <button onClick={() => void perform(() => load(token))}>Retry</button></div>}{notice && <p role="status">{notice}</p>}
    {profile && <section><h2>Profile</h2><div className="profile-summary">{profile.photo ? <img src={profile.photo} alt="Profile"/> : <span className="avatar">{profile.first_name.charAt(0)}</span>}<strong>{profile.first_name} {profile.last_name} · ★ {profile.rating.toFixed(2)}</strong></div>
      <form onSubmit={e => {e.preventDefault(); void perform(async () => {const {first_name, last_name, phone, email, photo: image} = profile; setProfile(await api<Profile>('/profile', {method: 'PUT', body: JSON.stringify({first_name, last_name, phone, email, photo: image})}, token)); setNotice('Profile saved.');});}}>
        <label>First name<input required maxLength={60} value={profile.first_name} onChange={e => change('first_name', e.target.value)}/></label><label>Last name<input maxLength={60} value={profile.last_name} onChange={e => change('last_name', e.target.value)}/></label><label>Phone<input type="tel" value={profile.phone} onChange={e => change('phone', e.target.value)}/></label><label>Email<input type="email" value={profile.email} onChange={e => change('email', e.target.value)}/></label><label>Profile photo (PNG, JPEG or WebP under 140 KB)<input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => photo(e.target.files?.[0])}/></label>{profile.photo && <button type="button" onClick={() => change('photo', '')}>Remove photo</button>}<button className="primary" disabled={busy}>Save profile</button>
      </form></section>}
    <section><h2>RideNow Wallet</h2><p>Simulated balance: ₹{(balance / 100).toFixed(2)}. No real money is added or charged.</p><form onSubmit={e => {e.preventDefault(); void perform(async () => {const n = Number(amount); if (!Number.isFinite(n) || n <= 0 || n > 100000 || Math.abs(n * 100 - Math.round(n * 100)) > .00001) throw new Error('Enter an amount from ₹0.01 to ₹100,000, to the nearest paise.'); const w = await api<{balance_paise: number}>('/wallet/funds', {method: 'POST', body: JSON.stringify({amount_paise: Math.round(n * 100)})}, token, 'activity'); setBalance(w.balance_paise); setNotice('Simulated funds added.');});}}><label>Amount in rupees<input type="number" min="0.01" max="100000" step="0.01" value={amount} onChange={e => setAmount(e.target.value)}/></label><button className="primary" disabled={busy}>Add mock funds</button></form></section>
    <section><h2>Appearance</h2><label>Theme<select value={theme} onChange={e => {try {localStorage.setItem('ridenow_theme', e.target.value); setTheme(e.target.value); window.dispatchEvent(new Event('ridenow-theme'));} catch {setError('Could not save appearance on this device.');}}}><option value="light">Light</option><option value="dark">Dark</option><option value="system">System Default</option></select></label></section>
    <section><h2>Saved places</h2>{saved.length === 0 && <p>No saved places yet. Home and Work suggestions are available on Home.</p>}{saved.map(p => <div key={p.id}><strong>{p.label}</strong> · {p.name} <button disabled={busy} onClick={() => void perform(async () => {await api(`/saved/${p.id}`, {method: 'DELETE'}, token, 'locations'); setSaved(saved.filter(x => x.id !== p.id)); setNotice('Place removed.');})}>Remove {p.label}</button></div>)}<form onSubmit={e => {e.preventDefault(); void perform(async () => {if (!places[Number(place)]) throw new Error('Choose a location.'); const p = await api<SavedPlace>('/saved', {method: 'PUT', body: JSON.stringify({...places[Number(place)], label})}, token, 'locations'); setSaved([...saved.filter(x => x.id !== p.id), p]); setNotice('Place saved.');});}}><label>Label<input required maxLength={40} value={label} onChange={e => setLabel(e.target.value)}/></label><label>Location<select value={place} onChange={e => setPlace(e.target.value)}>{places.map((p, i) => <option key={p.name} value={i}>{p.name}</option>)}</select></label><button className="primary" disabled={busy || !places.length}>Save place</button></form></section>
    <section><h2>Payments and safety</h2><p>Payment choices are available when booking. No card information is collected or payment processed. The safety shield appears while tracking a simulated journey; no emergency service is contacted.</p><a href="/">Choose a ride</a></section>
  </main>;
}
