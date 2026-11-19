'use client';

import dynamic from 'next/dynamic';
import React, { useEffect, useState } from 'react';
import { api, type Location, type LocationPage, type SavedPlace } from '../lib/api';
import Booking from './Booking';

const Map = dynamic(() => import('./Map'), { ssr: false, loading: () => <p role="status">Loading map…</p> });
const defaults: Record<string, Location> = {
  Home: {name: 'Banjara Hills Road No. 12', lat: 17.4156, lng: 78.435},
  Work: {name: 'Cyber Towers, Hitec City', lat: 17.4504, lng: 78.3808},
};
const recentKey = 'ridenow_recent_locations';

/** Let an authenticated rider search, select, and save Hyderabad places. */
export default function Search({ token, onAccount }: { token: string; onAccount: () => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Location[]>([]);
  const [saved, setSaved] = useState<SavedPlace[]>([]);
  const [recent, setRecent] = useState<Location[]>([]);
  const [selected, setSelected] = useState<Location | null>(null);
  const [bookingDestination, setBookingDestination] = useState<Location | null>(null);
  const [bookingPickup, setBookingPickup] = useState<Location | undefined>();
  const [initialVehicle, setInitialVehicle] = useState<'bike' | 'parcel'>('bike');
  const [label, setLabel] = useState('Home');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedError, setSavedError] = useState('');
  const [notice, setNotice] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('service') === 'parcel') setInitialVehicle('parcel');
    try {
      const stored = localStorage.getItem('ridenow_rebook');
      if (stored) {
        const route = JSON.parse(stored) as { token: string; pickup: Location; destination: Location };
        const valid = (p: Location) => typeof p?.name === 'string' && p.name.trim().length > 0 && typeof p.lat === 'number' && Number.isFinite(p.lat) && p.lat >= 17.2 && p.lat <= 17.55 && typeof p.lng === 'number' && Number.isFinite(p.lng) && p.lng >= 78.3 && p.lng <= 78.7;
        if (route.token !== token || !valid(route.pickup) || !valid(route.destination)) throw new Error('Invalid route');
        setBookingPickup(route.pickup); setBookingDestination(route.destination); setSelected(route.destination);
        localStorage.removeItem('ridenow_rebook');
      }
    } catch { try { localStorage.removeItem('ridenow_rebook'); } catch { /* Storage is unavailable. */ } setNotice('The saved rebook route could not be read.'); }
  }, [token]);

  useEffect(() => {
    try {
      const data: unknown = JSON.parse(localStorage.getItem(recentKey) || '[]');
      if (Array.isArray(data)) setRecent(data.filter(item => item && typeof item.name === 'string' && typeof item.lat === 'number' && typeof item.lng === 'number' && item.lat >= 17.2 && item.lat <= 17.55 && item.lng >= 78.3 && item.lng <= 78.7).slice(0, 6));
    } catch { setNotice('Recent searches could not be read on this device.'); }
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    const timeout = window.setTimeout(() => {
      api<LocationPage<Location>>(`/search?q=${encodeURIComponent(query)}&limit=10`, {}, token, 'locations')
        .then(data => { if (active) setResults(data.items); })
        .catch((e: Error) => { if (active) { setResults([]); setError(e.message); } })
        .finally(() => { if (active) setLoading(false); });
    }, 200);
    return () => { active = false; window.clearTimeout(timeout); };
  }, [query, token, retry]);
  useEffect(() => {
    let active = true;
    setSavedError('');
    api<LocationPage<SavedPlace>>('/saved', {}, token, 'locations').then(data => { if (active) setSaved(data.items); }).catch((e: Error) => { if (active) setSavedError(e.message); });
    return () => { active = false; };
  }, [token, retry]);

  function select(place: Location) {
    const point = {name: place.name, lat: place.lat, lng: place.lng};
    setSelected(point); setNotice('');
    setRecent(previous => {
      const next = [point, ...previous.filter(item => item.name !== point.name)].slice(0, 6);
      try { localStorage.setItem(recentKey, JSON.stringify(next)); } catch { setNotice('Could not save recent searches on this device.'); }
      return next;
    });
  }
  async function save() {
    if (!selected) return;
    setSaving(true); setSavedError(''); setNotice('');
    try {
      const place = await api<SavedPlace>('/saved', {method: 'PUT', body: JSON.stringify({...selected, label})}, token, 'locations');
      setSaved(previous => [...previous.filter(item => item.id !== place.id), place]);
      setNotice(`${place.label} saved.`);
    } catch (e) { setSavedError(e instanceof Error ? e.message : 'Could not save place.'); }
    finally { setSaving(false); }
  }
  async function remove(place: SavedPlace) {
    setSaving(true); setSavedError(''); setNotice('');
    try {
      await api<void>(`/saved/${place.id}`, {method: 'DELETE'}, token, 'locations');
      setSaved(previous => previous.filter(item => item.id !== place.id)); setNotice(`${place.label} removed.`);
    } catch (e) { setSavedError(e instanceof Error ? e.message : 'Could not remove place.'); }
    finally { setSaving(false); }
  }
  return <main className="home-shell">
    <header className="home-header"><span className="brand">RideNow<span className="brand-dot">.</span></span><span>HYDERABAD</span><button onClick={onAccount}>Account &amp; profile</button></header>
    <Map location={selected} onSelect={select} />
    {bookingDestination ? <div className="search-panel"><Booking token={token} destination={bookingDestination} pickup={bookingPickup} initialVehicle={initialVehicle} onBack={() => {setBookingDestination(null); setBookingPickup(undefined);}} /></div> : <section className="search-panel" aria-labelledby="where-title">
      <div className="card-kicker">YOUR CITY, IN MOTION</div><h1 id="where-title">Where to?</h1>
      <label htmlFor="destination">Search Hyderabad</label><input id="destination" autoComplete="off" placeholder="Search a place or landmark" value={query} onChange={e => setQuery(e.target.value)} />
      {loading && <p role="status">Searching locations…</p>}
      {error && <div role="alert">{error} <button onClick={() => setRetry(value => value + 1)}>Retry</button></div>}
      {!loading && !error && results.length === 0 && <p>No places found. Try another search or choose a point on the map.</p>}
      {!loading && !error && <div className="place-list" aria-label="Search results">{results.map(place => <button key={place.name} onClick={() => select(place)}>{place.name}<span>↗</span></button>)}</div>}
      <h2>Popular hotspots</h2><div className="hotspots">{['RGIA', 'Secunderabad Railway Station', 'Inorbit Mall', 'Mindspace'].map(term => <button key={term} onClick={() => setQuery(term)}>{term}</button>)}</div>
      <p className="map-help">Click the map or drag the destination pin to choose a custom point. The blue dot is your simulated pickup.</p>
      {selected && <div className="selection"><strong>Selected destination</strong><p>{selected.name}</p><small>{selected.lat.toFixed(5)}, {selected.lng.toFixed(5)}</small><button className="primary" onClick={() => setBookingDestination(selected)}>Compare rides</button><label htmlFor="place-label">Save as</label><input id="place-label" maxLength={40} value={label} onChange={e => setLabel(e.target.value)} /><button className="primary" disabled={saving || !label.trim()} onClick={() => void save()}>{saving ? 'Saving…' : 'Save place'}</button></div>}
      {notice && <p role="status">{notice}</p>}{savedError && <div role="alert">{savedError} <button onClick={() => setRetry(value => value + 1)}>Retry loading places</button></div>}
      <h2>Saved places</h2><div className="saved-list">{Object.entries(defaults).filter(([name]) => !saved.some(item => item.label.toLowerCase() === name.toLowerCase())).map(([name, place]) => <button key={name} onClick={() => select(place)}>{name} <span>{place.name} · suggested</span></button>)}{saved.map(place => <div key={place.id}><button onClick={() => select(place)}>{place.label}<span>{place.name}</span></button><button disabled={saving} aria-label={`Remove ${place.label}`} onClick={() => void remove(place)}>Remove</button></div>)}</div>
      {recent.length > 0 && <><h2>Recent searches</h2><div className="place-list">{recent.map(place => <button key={place.name} onClick={() => select(place)}>{place.name}</button>)}</div></>}
      <p className="small">Map vehicles, pickup and booking are simulated.</p>
    </section>}
  </main>;
}
