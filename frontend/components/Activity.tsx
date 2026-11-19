'use client';

import React, { useEffect, useState } from 'react';
import {
  api,
  NetworkError,
  type HistoryRide,
  type Location,
  type LocationPage,
  type Receipt,
  type Schedule,
} from '../lib/api';
import FeedbackForm from './FeedbackForm';

const message = (e: unknown) => (e instanceof Error ? e.message : 'Please try again.');
const cacheKey = 'ridenow_activity_cache';
type Cache = {
  token: string;
  pages: Record<string, LocationPage<HistoryRide>>;
  receipts: Record<string, Receipt>;
  savedAt: string;
};
/** Read only the current session's cache; malformed or inaccessible storage is ignored. */
function readCache(token: string): Cache | null {
  try {
    const data = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    return data?.token === token && data.pages && data.receipts ? (data as Cache) : null;
  } catch {
    return null;
  }
}
/** Store a best-effort offline copy for this browser session. */
function saveCache(token: string, update: (cache: Cache) => void) {
  try {
    const cache = readCache(token) || { token, pages: {}, receipts: {}, savedAt: '' };
    update(cache);
    cache.savedAt = new Date().toISOString();
    localStorage.setItem(cacheKey, JSON.stringify(cache));
  } catch {
    /* Storage may be unavailable; online activity still works. */
  }
}

/** Show persisted activity, receipts, feedback, and future reservations. */
export default function Activity({
  mode = 'activity',
}: {
  mode?: 'activity' | 'services';
}) {
  const [token, setToken] = useState('');
  const [ready, setReady] = useState(false);
  const [history, setHistory] = useState<HistoryRide[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [places, setPlaces] = useState<Location[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [scheduleTotal, setScheduleTotal] = useState(0);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [scheduleOffset, setScheduleOffset] = useState(0);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [stale, setStale] = useState('');
  const [kind, setKind] = useState<'reserve' | 'hourly'>('reserve');
  const [pickup, setPickup] = useState('0');
  const [destination, setDestination] = useState('1');
  const [when, setWhen] = useState('');
  const [vehicle, setVehicle] = useState('bike');
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  async function load(t: string, hOffset = historyOffset, sOffset = scheduleOffset) {
    let h: LocationPage<HistoryRide>;
    try {
      h = await api<LocationPage<HistoryRide>>(
        `/history?offset=${hOffset}`,
        {},
        t,
        'activity',
      );
      saveCache(t, (cache) => {
        cache.pages[String(hOffset)] = h;
      });
      setStale('');
    } catch (e) {
      const cache = e instanceof NetworkError ? readCache(t) : null;
      const page = cache?.pages[String(hOffset)];
      if (!page || !Array.isArray(page.items) || typeof page.total !== 'number') {
        setHistory([]);
        setHistoryTotal(0);
        setStale('');
        throw e;
      }
      setHistory(page.items);
      setHistoryTotal(page.total);
      setSchedules([]);
      setScheduleTotal(0);
      setPlaces([]);
      setReceipt(null);
      setStale(cache?.savedAt || 'unknown time');
      return;
    }
    setHistory(h.items);
    setHistoryTotal(h.total);
    if (stale) setReceipt(null);
    const [s, p] = await Promise.all([
      api<LocationPage<Schedule>>(`/schedules?offset=${sOffset}`, {}, t, 'activity'),
      api<LocationPage<Location>>('/search?limit=50', {}, t, 'locations'),
    ]);
    setSchedules(s.items);
    setScheduleTotal(s.total);
    setPlaces(p.items);
  }
  useEffect(() => {
    const t = localStorage.getItem('ridenow_session') || '';
    setToken(t);
    if (!t) {
      setReady(true);
      return;
    }
    load(t)
      .catch((e) => setError(message(e)))
      .finally(() => setReady(true));
  }, []);
  useEffect(() => {
    if (!token || stale || !schedules.length) return;
    const next = Math.min(...schedules.map((s) => new Date(s.scheduled_at).getTime()));
    const timer = window.setTimeout(
      () => {
        void load(token).catch((e) => setError(message(e)));
      },
      Math.max(0, Math.min(2147483647, next - Date.now() + 10)),
    );
    return () => window.clearTimeout(timer);
  }, [token, stale, schedules]);
  async function perform(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function openReceipt(id: string) {
    try {
      const r = await api<Receipt>(`/history/${id}`, {}, token, 'activity');
      setReceipt(r);
      saveCache(token, (cache) => {
        cache.receipts[id] = r;
      });
    } catch (e) {
      const r = e instanceof NetworkError ? readCache(token)?.receipts[id] : null;
      if (!r) throw e;
      setReceipt(r);
      setStale(readCache(token)?.savedAt || 'unknown time');
    }
  }
  function edit(s: Schedule) {
    setKind(s.kind);
    setEditing(s.id);
    setVehicle(s.vehicle.id);
    const local = new Date(
      new Date(s.scheduled_at).getTime() -
        new Date(s.scheduled_at).getTimezoneOffset() * 60000,
    )
      .toISOString()
      .slice(0, 16);
    setWhen(local);
    setPlaces((old) => {
      const next = [...old];
      const index = (point: Location) => {
        const i = next.findIndex(
          (p) => p.lat === point.lat && p.lng === point.lng && p.name === point.name,
        );
        if (i >= 0) return i;
        next.push(point);
        return next.length - 1;
      };
      setPickup(String(index(s.pickup)));
      setDestination(String(index(s.destination)));
      return next;
    });
  }
  function download(r: Receipt) {
    const text = `RideNow simulated receipt\n${r.created_at}\n${r.pickup.name} → ${r.destination.name}\n${r.vehicle.name}\nBase and distance: ₹${r.breakdown.base_and_distance.toFixed(2)}\nTier fee: ₹${r.breakdown.tier_fee.toFixed(2)}\nTime: ₹${r.breakdown.time.toFixed(2)}\nSurge: ₹${r.breakdown.surge.toFixed(2)}\nDiscount: ₹${r.breakdown.discount.toFixed(2)}\nTotal: ₹${r.breakdown.total.toFixed(2)}\nNo real payment was made.\n`;
    const url = URL.createObjectURL(
      new Blob([text], { type: 'text/plain;charset=utf-8' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `ridenow-${r.id}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }
  if (!ready)
    return (
      <main className="feature-page" role="status">
        Loading activity…
      </main>
    );
  if (!token)
    return (
      <main className="feature-page">
        <h1>Sign in to continue</h1>
        <a href="/">Go to sign in</a>
      </main>
    );
  return (
    <main className="feature-page">
      <div className="card-kicker">RIDENOW · HYDERABAD</div>
      <h1>{mode === 'activity' ? 'Your activity' : 'Services'}</h1>
      {error && (
        <div role="alert" className="alert">
          {error} <button onClick={() => void perform(() => load(token))}>Retry</button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {stale && (
        <p role="status">
          Offline: showing previously cached history; it may be stale. Reservations and
          changes require a connection.{' '}
          <button onClick={() => void perform(() => load(token))}>
            Retry connection
          </button>
        </p>
      )}
      {mode === 'services' && (
        <>
          <p>Every service is a simulation. No driver is dispatched or payment taken.</p>
          <div className="service-links">
            <a href="/">Rides</a>
            <a href="/?service=parcel">Packages</a>
            <button onClick={() => setKind('hourly')}>Hourly</button>
            <button onClick={() => setKind('reserve')}>Reserve</button>
          </div>
        </>
      )}
      {!stale && (
        <section>
          <h2>Upcoming reservations</h2>
          <p>
            Future times only. Edit or cancel before the scheduled time. Hourly uses the
            same route estimate; no hourly tariff or duration is implied. Reservations do
            not dispatch a driver.
          </p>
          {schedules.length === 0 && <p>No upcoming reservations.</p>}
          {schedules.map((s) => (
            <article className="activity-card" key={s.id}>
              <strong>
                {s.kind === 'hourly' ? 'Hourly' : 'Reserve'} ·{' '}
                {new Date(s.scheduled_at).toLocaleString()}
              </strong>
              <p>
                {s.pickup.name} → {s.destination.name}
              </p>
              <p>
                {s.vehicle.name} · estimate ₹{s.vehicle.fare.toFixed(2)}
              </p>
              <button onClick={() => edit(s)}>Edit</button>{' '}
              <button
                disabled={busy}
                onClick={() => {
                  if (window.confirm('Cancel this simulated reservation?'))
                    void perform(async () => {
                      await api(
                        `/schedules/${s.id}/cancel`,
                        { method: 'POST' },
                        token,
                        'activity',
                      );
                      await load(token);
                      setNotice('Reservation cancelled. No fee was charged.');
                    });
                }}
              >
                Cancel reservation
              </button>
            </article>
          ))}
          {scheduleTotal > 50 && (
            <div>
              <button
                disabled={busy || scheduleOffset === 0}
                onClick={() =>
                  void perform(async () => {
                    const next = Math.max(0, scheduleOffset - 50);
                    await load(token, historyOffset, next);
                    setScheduleOffset(next);
                  })
                }
              >
                Previous reservations
              </button>{' '}
              <button
                disabled={busy || scheduleOffset + 50 >= scheduleTotal}
                onClick={() =>
                  void perform(async () => {
                    const next = scheduleOffset + 50;
                    await load(token, historyOffset, next);
                    setScheduleOffset(next);
                  })
                }
              >
                Next reservations
              </button>
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                if (!places[Number(pickup)] || !places[Number(destination)] || !when)
                  throw new Error('Choose a route and future time.');
                const time = new Date(when);
                if (Number.isNaN(time.getTime()) || time.getTime() <= Date.now())
                  throw new Error('Choose a future time.');
                const body = {
                  kind,
                  pickup: places[Number(pickup)],
                  destination: places[Number(destination)],
                  scheduled_at: time.toISOString(),
                  vehicle,
                };
                await api(
                  editing ? `/schedules/${editing}` : '/schedules',
                  { method: editing ? 'PUT' : 'POST', body: JSON.stringify(body) },
                  token,
                  'activity',
                );
                setEditing(null);
                setWhen('');
                await load(token);
                setNotice('Reservation saved. No payment or dispatch occurred.');
              });
            }}
          >
            <h3>{editing ? 'Edit reservation' : 'Plan a reservation'}</h3>
            <label>
              Service
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as 'reserve' | 'hourly')}
              >
                <option value="reserve">Reserve</option>
                <option value="hourly">Hourly</option>
              </select>
            </label>
            <label>
              Pickup
              <select value={pickup} onChange={(e) => setPickup(e.target.value)}>
                {places.map((p, i) => (
                  <option value={i} key={`${p.name}-${i}`}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Destination
              <select
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
              >
                {places.map((p, i) => (
                  <option value={i} key={`${p.name}-${i}`}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Future date and time
              <input
                required
                type="datetime-local"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
              />
            </label>
            <label>
              Vehicle
              <select value={vehicle} onChange={(e) => setVehicle(e.target.value)}>
                {['bike', 'auto', 'ubergo', 'premier', 'uberxl', 'black'].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary" disabled={busy || places.length < 2}>
              {editing ? 'Save changes' : 'Save reservation'}
            </button>
            {editing && (
              <button type="button" onClick={() => setEditing(null)}>
                Discard edit
              </button>
            )}
          </form>
        </section>
      )}
      {mode === 'activity' && (
        <section>
          <h2>Past journeys</h2>
          {historyTotal === 0 && <p>No completed journeys yet.</p>}
          {history.map((r) => (
            <article className="activity-card" key={r.id}>
              <strong>
                {r.vehicle.name} · {new Date(r.created_at).toLocaleString()}
              </strong>
              <p>
                {r.pickup.name} → {r.destination.name}
              </p>
              <p>₹{r.vehicle.fare.toFixed(2)}</p>
              <button
                disabled={busy}
                onClick={() => void perform(() => openReceipt(r.id))}
              >
                View receipt
              </button>
            </article>
          ))}
          {historyTotal > 50 && (
            <div>
              <button
                disabled={busy || historyOffset === 0}
                onClick={() =>
                  void perform(async () => {
                    const next = Math.max(0, historyOffset - 50);
                    await load(token, next, scheduleOffset);
                    setHistoryOffset(next);
                  })
                }
              >
                Previous journeys
              </button>{' '}
              <button
                disabled={busy || historyOffset + 50 >= historyTotal}
                onClick={() =>
                  void perform(async () => {
                    const next = historyOffset + 50;
                    await load(token, next, scheduleOffset);
                    setHistoryOffset(next);
                  })
                }
              >
                Next journeys
              </button>
            </div>
          )}
        </section>
      )}
      {receipt && (
        <section className="activity-card" aria-labelledby="receipt-title">
          <h2 id="receipt-title">Receipt · {receipt.vehicle.name}</h2>
          <p>
            {receipt.pickup.name} → {receipt.destination.name}
          </p>
          <p>
            {new Date(receipt.created_at).toLocaleString()} ·{' '}
            {receipt.distance_km.toFixed(2)} km estimated
          </p>
          <dl>
            <dt>Base and distance</dt>
            <dd>₹{receipt.breakdown.base_and_distance.toFixed(2)}</dd>
            <dt>Tier fee</dt>
            <dd>₹{receipt.breakdown.tier_fee.toFixed(2)}</dd>
            <dt>Time</dt>
            <dd>₹{receipt.breakdown.time.toFixed(2)}</dd>
            <dt>Surge ({receipt.surge_multiplier}×)</dt>
            <dd>₹{receipt.breakdown.surge.toFixed(2)}</dd>
            <dt>Discount</dt>
            <dd>₹{receipt.breakdown.discount.toFixed(2)}</dd>
            <dt>Total</dt>
            <dd>₹{receipt.breakdown.total.toFixed(2)}</dd>
          </dl>
          <p>No real payment was made.</p>
          <button onClick={() => window.print()}>Print</button>{' '}
          <button onClick={() => download(receipt)}>Download receipt</button>{' '}
          <button
            onClick={() => {
              try {
                localStorage.setItem(
                  'ridenow_rebook',
                  JSON.stringify({
                    token,
                    pickup: receipt.pickup,
                    destination: receipt.destination,
                  }),
                );
                window.location.assign('/');
              } catch {
                setError('Could not save route on this device.');
              }
            }}
          >
            Rebook This Ride
          </button>
          {!stale && (
            <FeedbackForm
              token={token}
              rideId={receipt.id}
              initial={receipt.feedback}
              onSaved={(feedback) => {
                const updated = { ...receipt, feedback };
                setReceipt(updated);
                saveCache(token, (cache) => {
                  cache.receipts[receipt.id] = updated;
                });
              }}
            />
          )}
        </section>
      )}
    </main>
  );
}
