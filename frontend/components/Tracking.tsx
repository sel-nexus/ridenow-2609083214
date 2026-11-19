'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type * as Leaflet from 'leaflet';
import {
  api,
  type Feedback,
  type Receipt,
  type RideBooking,
  type TrackingState,
} from '../lib/api';
import FeedbackForm from './FeedbackForm';

const symbols: Record<string, string> = {
  bike: '<circle cx="5" cy="18" r="3"/><circle cx="19" cy="18" r="3"/><path d="M5 18l5-8 4 8H5m5-8h5l4 8m-6-11h3"/>',
  auto: '<path d="M3 17h18l-1-8H7L3 14zM8 9l2-4h6l3 4"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>',
  ubergo:
    '<path d="M3 17h18v-5l-4-4H8l-4 4z"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>',
  premier:
    '<path d="M2 17h20v-4l-4-2-3-4H9l-4 4-3 2z"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>',
  uberxl:
    '<path d="M2 17h20V9l-3-3H7L3 10z"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>',
  black:
    '<path d="M2 17h20v-4l-4-2-3-4H9l-4 4-3 2z" fill="currentColor"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>',
  parcel:
    '<circle cx="5" cy="18" r="3"/><circle cx="19" cy="18" r="3"/><path d="M5 18l5-7 4 7H5m5-7h5l4 7M12 4h7v6h-7z"/>',
};
const labels: Record<string, string> = {
  matching: 'Finding your nearest driver in Hyderabad…',
  assigned: 'Partner Assigned',
  on_way: 'On the way to Pickup',
  arrived: 'Driver has arrived',
  collected: 'Package Collected',
  transit: 'In Transit',
  delivered: 'Delivered',
  in_trip: 'Trip in progress',
  completed: 'Trip completed',
  cancelled: 'Journey cancelled',
};

/** Draw a simulated straight-line route and category-specific moving marker. */
function TrackingMap({ tracking }: { tracking: TrackingState }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const marker = useRef<Leaflet.Marker | null>(null);
  const latest = useRef(tracking);
  latest.current = tracking;
  useEffect(() => {
    let disposed = false;
    void import('leaflet')
      .then((L) => {
        if (disposed || !container.current) return;
        const { pickup, destination, vehicle } = latest.current.booking;
        const a: [number, number] = [pickup.lat, pickup.lng];
        const b: [number, number] = [destination.lat, destination.lng];
        const instance = L.map(container.current, { zoomControl: false }).fitBounds(
          [a, b],
          { padding: [25, 25], maxZoom: 14 },
        );
        map.current = instance;
        const dark = document.documentElement.dataset.theme === 'dark';
        const tiles = L.tileLayer(
          dark
            ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
            : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
          { attribution: '&copy; OpenStreetMap contributors', maxZoom: 19 },
        ).addTo(instance);
        const updateTheme = () =>
          tiles.setUrl(
            document.documentElement.dataset.theme === 'dark'
              ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
              : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
          );
        window.addEventListener('ridenow-resolved-theme', updateTheme);
        instance.once('unload', () =>
          window.removeEventListener('ridenow-resolved-theme', updateTheme),
        );
        if (!L.Browser.svg) {
          if (container.current)
            container.current.setAttribute(
              'aria-label',
              'Route map unavailable; journey status remains available',
            );
          return;
        }
        L.polyline([a, b], { color: '#1672ee', weight: 4 }).addTo(instance);
        L.circleMarker(a, { radius: 6, color: '#1672ee' })
          .addTo(instance)
          .bindTooltip('Pickup');
        L.circleMarker(b, { radius: 6, color: '#111' })
          .addTo(instance)
          .bindTooltip('Destination');
        const icon = L.divIcon({
          className: 'tracking-vehicle',
          html: `<span><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7">${symbols[vehicle.id] || symbols.ubergo}</svg></span>`,
          iconSize: [32, 32],
        });
        marker.current = L.marker(a, { icon, interactive: false }).addTo(instance);
      })
      .catch(() => {
        if (!disposed && container.current)
          container.current.textContent =
            'Map unavailable; journey status remains available.';
      });
    return () => {
      disposed = true;
      map.current?.remove();
      map.current = null;
      marker.current = null;
    };
  }, []);
  useEffect(() => {
    const { pickup, destination } = tracking.booking;
    const trip =
      tracking.state === 'in_trip' ||
      tracking.state === 'transit' ||
      tracking.state === 'completed' ||
      tracking.state === 'delivered';
    const progress = trip ? tracking.progress : 0;
    const approach =
      tracking.state === 'on_way' && tracking.arrival_seconds
        ? Math.min(1, tracking.seconds_to_arrival / tracking.arrival_seconds)
        : 0;
    marker.current?.setLatLng([
      pickup.lat + (destination.lat - pickup.lat) * progress + 0.004 * approach,
      pickup.lng + (destination.lng - pickup.lng) * progress + 0.004 * approach,
    ]);
    const icon = marker.current?.getElement()?.querySelector('span');
    if (icon)
      icon.style.rotate = `${trip ? (Math.atan2(destination.lat - pickup.lat, destination.lng - pickup.lng) * -180) / Math.PI : 225}deg`;
  }, [tracking]);
  return (
    <div className="tracking-map" ref={container} aria-label="Simulated route map" />
  );
}

/** Track the server-owned simulation, including parcel and safety actions. */
export default function Tracking({
  token,
  booking,
  onBack,
}: {
  token: string;
  booking: RideBooking;
  onBack: () => void;
}) {
  const [tracking, setTracking] = useState<TrackingState | null>(null);
  const [error, setError] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [panel, setPanel] = useState<'call' | 'chat' | 'safety' | null>(null);
  const [notice, setNotice] = useState('');
  const [rideCheck, setRideCheck] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [feedbackLoaded, setFeedbackLoaded] = useState(false);
  const [feedbackError, setFeedbackError] = useState('');
  const [feedbackRetry, setFeedbackRetry] = useState(0);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const refreshSequence = useRef(0);
  const refresh = useCallback(async () => {
    const requestGeneration = generation.current;
    const sequence = ++refreshSequence.current;
    try {
      const result = await api<TrackingState>(`/${booking.id}`, {}, token, 'tracking');
      if (
        !busyRef.current &&
        requestGeneration === generation.current &&
        sequence === refreshSequence.current
      ) {
        setTracking(result);
        setError('');
      }
    } catch (e) {
      if (
        requestGeneration === generation.current &&
        sequence === refreshSequence.current
      )
        setError(e instanceof Error ? e.message : 'Tracking unavailable.');
    }
  }, [booking.id, token]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (tracking?.state !== 'completed' && tracking?.state !== 'delivered') return;
    let active = true;
    api<Receipt>(`/history/${booking.id}`, {}, token, 'activity')
      .then((receipt) => {
        if (active) {
          setFeedback(receipt.feedback);
          setFeedbackLoaded(true);
          setFeedbackError('');
        }
      })
      .catch((e) => {
        if (active)
          setFeedbackError(e instanceof Error ? e.message : 'Could not load feedback.');
      });
    return () => {
      active = false;
    };
  }, [tracking?.state, booking.id, token, feedbackRetry]);
  useEffect(() => {
    if (tracking?.state !== 'in_trip' && tracking?.state !== 'transit') return;
    const timer = window.setInterval(() => setRideCheck(true), 15000);
    return () => window.clearInterval(timer);
  }, [tracking?.state]);
  async function action(path: string, body?: object) {
    if (busyRef.current) return;
    generation.current += 1;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      setTracking(
        await api<TrackingState>(
          `/${booking.id}/${path}`,
          { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) },
          token,
          'tracking',
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed.');
    } finally {
      generation.current += 1;
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function share() {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/#simulated-trip-${booking.id}`,
      );
      setNotice('Simulated trip reference copied. It is not a live tracking link.');
    } catch {
      setNotice('Could not copy the simulated trip reference.');
    }
  }
  const terminal =
    tracking && ['cancelled', 'completed', 'delivered'].includes(tracking.state);
  const parcel = booking.vehicle.id === 'parcel';
  return (
    <section className="booking-panel tracking-panel" aria-labelledby="tracking-title">
      <div className="card-kicker">SIMULATED JOURNEY</div>
      <h1 id="tracking-title">{parcel ? 'Track your parcel' : 'Track your ride'}</h1>
      <p>No real driver, call, emergency service or delivery is dispatched.</p>
      {error && (
        <div role="alert" className="alert">
          {error} <button onClick={() => void refresh()}>Retry</button>
        </div>
      )}
      {!tracking ? (
        <p role="status">Loading tracking…</p>
      ) : (
        <>
          <TrackingMap tracking={tracking} />
          <p role="status">
            {tracking.state === 'matching' && (
              <span className="tracking-scan" aria-hidden="true" />
            )}
            <strong>{labels[tracking.state] || tracking.state}</strong>
            {tracking.state === 'on_way' &&
              ` · ${tracking.seconds_to_arrival}s to pickup`}
          </p>
          <p className="small">
            Route is a straight-line simulation, not live road routing.
          </p>
          {tracking.driver && (
            <div className="driver-card">
              <span className="avatar" aria-label="Illustrative driver portrait">
                <svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">
                  <circle cx="24" cy="17" r="8" fill="currentColor" />
                  <path d="M8 42c1-11 7-16 16-16s15 5 16 16" fill="currentColor" />
                </svg>
              </span>
              <div>
                <strong>{tracking.driver.name}</strong>
                <br />★ {tracking.driver.rating.toFixed(2)} · {tracking.driver.trips}{' '}
                trips
                <br />
                {tracking.driver.model} · {tracking.driver.plate}
              </div>
            </div>
          )}
          {tracking.pin && !terminal && (
            <p>
              Safety PIN: <strong className="tracking-pin">{tracking.pin}</strong>
            </p>
          )}
          {tracking.state === 'arrived' && (
            <div>
              <label htmlFor="trip-pin">
                Enter safety PIN to {parcel ? 'collect package' : 'start trip'}
              </label>
              <input
                id="trip-pin"
                inputMode="numeric"
                maxLength={4}
                value={pin}
                onChange={(e) => setPin(e.target.value)}
              />
              <p>
                {3 - tracking.attempts} attempts remaining. Three incorrect attempts
                cancel the journey.
              </p>
              <button
                className="primary"
                disabled={busy || !/^[0-9]{4}$/.test(pin)}
                onClick={() => void action('pin', { pin })}
              >
                {parcel ? 'Verify and collect' : 'Start Trip'}
              </button>
            </div>
          )}
          {parcel && (
            <>
              <ol className="parcel-timeline">
                {[
                  'Partner Assigned',
                  'On the way to Pickup',
                  'Package Collected',
                  'In Transit',
                  'Delivered',
                ].map((stage, index) => (
                  <li
                    key={stage}
                    className={
                      index <=
                      ({
                        assigned: 0,
                        on_way: 1,
                        arrived: 1,
                        collected: 2,
                        transit: 3,
                        delivered: 4,
                      }[tracking.state] ?? -1)
                        ? 'reached'
                        : ''
                    }
                  >
                    {stage}
                  </li>
                ))}
              </ol>
              {tracking.state === 'collected' && (
                <button disabled={busy} onClick={() => void action('parcel/transit')}>
                  Simulate transit
                </button>
              )}
              {tracking.state === 'transit' && (
                <button disabled={busy} onClick={() => void action('parcel/deliver')}>
                  Simulate delivery
                </button>
              )}
              {tracking.state === 'delivered' && (
                <figure className="notice delivery-proof">
                  <strong>Simulated proof of delivery</strong>
                  <img
                    src="/delivery-illustration.svg"
                    alt="Illustration of a parcel at a doorstep"
                    width="640"
                    height="360"
                  />
                  <figcaption>
                    Illustration only — no real delivery or photograph was verified.
                  </figcaption>
                </figure>
              )}
            </>
          )}
          {!terminal && (
            <>
              <div className="tracking-actions">
                <button onClick={() => setPanel('call')}>Mock call</button>
                <button onClick={() => setPanel('chat')}>Mock chat</button>
                <button className="safety-shield" onClick={() => setPanel('safety')}>
                  Safety shield
                </button>
                <button onClick={() => setCancelConfirm(true)}>Cancel journey</button>
              </div>
              {cancelConfirm && (
                <div className="notice">
                  <p>Cancel this simulated journey? There is no cancellation fee.</p>
                  <button
                    disabled={busy}
                    onClick={() => {
                      setCancelConfirm(false);
                      void action('cancel', { confirmed: true });
                    }}
                  >
                    Confirm cancellation
                  </button>{' '}
                  <button onClick={() => setCancelConfirm(false)}>Keep journey</button>
                </div>
              )}
              {panel === 'call' && (
                <div className="notice">
                  <p>
                    Mock call to {tracking.driver?.name || 'your driver'}. No phone call
                    is placed.
                  </p>
                  <button onClick={() => setPanel(null)}>End mock call</button>
                </div>
              )}
              {panel === 'chat' && (
                <div className="notice">
                  <p>Mock chat · no message is sent.</p>
                  {["I'm at the pickup point", 'Be right there'].map((message) => (
                    <button
                      key={message}
                      onClick={() =>
                        setNotice(
                          `Simulated message: ${message} · Driver: Thanks, see you soon.`,
                        )
                      }
                    >
                      {message}
                    </button>
                  ))}{' '}
                  <button onClick={() => setPanel(null)}>Close chat</button>
                </div>
              )}
              {panel === 'safety' && (
                <div className="notice">
                  <strong>Safety simulation</strong>
                  <p>Simulated SOS 112 · no emergency service will be contacted.</p>
                  <p>
                    Simulated GPS:{' '}
                    {(
                      booking.pickup.lat +
                      (booking.destination.lat - booking.pickup.lat) * tracking.progress
                    ).toFixed(5)}
                    ,{' '}
                    {(
                      booking.pickup.lng +
                      (booking.destination.lng - booking.pickup.lng) * tracking.progress
                    ).toFixed(5)}{' '}
                    · {tracking.driver?.plate || 'Awaiting driver'}
                  </p>
                  <button
                    onClick={() =>
                      setNotice(
                        'SOS simulation only: no emergency service was contacted.',
                      )
                    }
                  >
                    Simulate SOS
                  </button>{' '}
                  <button onClick={() => void share()}>Share Trip</button>{' '}
                  <button onClick={() => setPanel(null)}>Close safety</button>
                </div>
              )}
              {rideCheck && (
                <div className="notice">
                  <p>Everything okay on your trip? (Simulated RideCheck)</p>
                  <button
                    onClick={() => {
                      setRideCheck(false);
                      setNotice('RideCheck acknowledged.');
                    }}
                  >
                    Yes, I’m okay
                  </button>{' '}
                  <button
                    onClick={() => {
                      setRideCheck(false);
                      setPanel('safety');
                    }}
                  >
                    Open safety
                  </button>
                </div>
              )}
            </>
          )}
          {notice && <p role="status">{notice}</p>}
          {terminal && (
            <>
              {tracking.state !== 'cancelled' && (
                <>
                  {feedbackError && (
                    <p role="alert">
                      {feedbackError}{' '}
                      <button onClick={() => setFeedbackRetry((n) => n + 1)}>
                        Retry feedback
                      </button>
                    </p>
                  )}
                  {feedbackLoaded ? (
                    <FeedbackForm
                      token={token}
                      rideId={booking.id}
                      initial={feedback}
                      onSaved={setFeedback}
                    />
                  ) : (
                    !feedbackError && <p role="status">Loading feedback…</p>
                  )}
                  <a href="/activity">View receipt and leave feedback</a>
                </>
              )}
              <button className="primary" onClick={onBack}>
                Choose another destination
              </button>
            </>
          )}
        </>
      )}
    </section>
  );
}
