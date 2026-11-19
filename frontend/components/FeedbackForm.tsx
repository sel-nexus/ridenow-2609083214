'use client';

import React, { useEffect, useState } from 'react';
import { api, type Feedback } from '../lib/api';

/** Let a rider save simulated feedback on a completed journey. */
export default function FeedbackForm({ token, rideId, initial, onSaved }: { token: string; rideId: string; initial: Feedback | null; onSaved?: (feedback: Feedback) => void }) {
  const [rating, setRating] = useState(initial?.rating ?? 5);
  const [compliments, setCompliments] = useState<string[]>(initial?.compliments ?? []);
  const [tip, setTip] = useState(String((initial?.tip_paise ?? 0) / 100));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    setRating(initial?.rating ?? 5); setCompliments(initial?.compliments ?? []); setTip(String((initial?.tip_paise ?? 0) / 100));
  }, [rideId, initial]);
  return <form onSubmit={e => { e.preventDefault(); void (async () => {
    const amount = Number(tip);
    if (!Number.isFinite(amount) || amount < 0 || amount > 10000 || Math.abs(amount * 100 - Math.round(amount * 100)) > .00001) { setError('Enter a tip from ₹0 to ₹10,000, to the nearest paise.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const saved = await api<Feedback>(`/history/${rideId}/feedback`, {method: 'PUT', body: JSON.stringify({rating, compliments, tip_paise: Math.round(amount * 100)})}, token, 'activity');
      onSaved?.(saved); setNotice('Feedback saved. The tip is simulated; no payment was made.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save feedback.'); }
    finally { setBusy(false); }
  })(); }}><h3>Rate your journey</h3>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <label>Rating<select value={rating} onChange={e => setRating(Number(e.target.value))}>{[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n} {n === 1 ? 'star' : 'stars'}</option>)}</select></label>
    <fieldset><legend>Compliments</legend>{['Clean vehicle', 'Polite driver', 'Great route navigation'].map(c => <label key={c}><input type="checkbox" checked={compliments.includes(c)} onChange={e => setCompliments(e.target.checked ? [...compliments, c] : compliments.filter(x => x !== c))}/>{c}</label>)}</fieldset>
    <label>Simulated tip (₹)<input type="number" min="0" max="10000" step="0.01" value={tip} onChange={e => setTip(e.target.value)} /></label>
    <div>{[0, 10, 20, 50].map(n => <button type="button" key={n} onClick={() => setTip(String(n))}>{n ? `₹${n.toFixed(2)}` : 'Skip tip'}</button>)}</div>
    <button className="primary" disabled={busy}>Save feedback</button>
  </form>;
}
