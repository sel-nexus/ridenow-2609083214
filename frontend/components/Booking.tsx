'use client';

import React, { useEffect, useState } from 'react';
import { api, type Location, type Quote, type RideBooking, type Parcel } from '../lib/api';
import Tracking from './Tracking';

const pickup: Location = { name: 'Simulated pickup, Hitec City', lat: 17.4435, lng: 78.3772 };
const methods = [
  ['cash', 'Cash — due at destination'],
  ['card_visa', 'Visa card'], ['card_mastercard', 'Mastercard'], ['card_rupay', 'RuPay'], ['card_amex', 'Amex'],
  ['upi_google_pay', 'UPI · Google Pay'], ['upi_phonepe', 'UPI · PhonePe'], ['upi_paytm', 'UPI · Paytm'], ['upi_custom', 'UPI · custom'],
  ['paytm_wallet', 'Paytm Wallet'], ['amazon_pay', 'Amazon Pay'],
  ['net_sbi', 'Net banking · SBI'], ['net_hdfc', 'Net banking · HDFC'], ['net_icici', 'Net banking · ICICI'], ['net_axis', 'Net banking · Axis'], ['ridenow_wallet', 'RideNow Wallet / credits'],
] as const;
const descriptions: Record<string, string> = {bike: 'Solo · fast in traffic', auto: 'Local three-wheeler', ubergo: 'Compact hatchback', premier: 'Comfort sedan', uberxl: 'SUV / MUV for groups', black: 'Premium black car', parcel: 'Courier delivery'};
const icons: Record<string, string> = {bike: '◉', auto: '▰', ubergo: '▱', premier: '▰', uberxl: '▣', black: '◆', parcel: '▤'};
const rupees = (value: number) => `₹${value.toFixed(2)}`;

/** Compare server fares and create a simulated booking for one destination. */
export default function Booking({ token, destination, onBack, pickup: start = pickup, initialVehicle = 'bike' }: { token: string; destination: Location; onBack: () => void; pickup?: Location; initialVehicle?: 'bike' | 'parcel' }) {
  const [quote, setQuote] = useState<Quote | null>(null);
  const [vehicle, setVehicle] = useState<string>(initialVehicle);
  const [payment, setPayment] = useState('cash');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [booking, setBooking] = useState<RideBooking | null>(null);
  const [trackingInfo, setTrackingInfo] = useState(false);
  const [parcel, setParcel] = useState<Parcel>({package_type: 'document', recipient_name: '', recipient_phone: '', instructions: '', courier_vehicle: 'two_wheeler'});
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true); setQuote(null); setError('');
    api<Quote>('/quotes', {method: 'POST', body: JSON.stringify({pickup: start, destination})}, token, 'booking')
      .then(result => { if (active) setQuote(result); })
      .catch((e: Error) => { if (active) setError(e.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [destination, token, retry, start]);

  async function confirm() {
    if (!quote || processing) return;
    if (vehicle === 'parcel' && (!parcel.recipient_name.trim() || !/^\+?[0-9]{10,15}$/.test(parcel.recipient_phone))) {
      setError('Enter a recipient name and a valid 10–15 digit phone number.'); return;
    }
    setProcessing(true); setError('');
    try {
      const [result] = await Promise.all([
        api<RideBooking>('/rides', {method: 'POST', body: JSON.stringify({quote_id: quote.id, vehicle, payment, ...(vehicle === 'parcel' ? {parcel} : {})})}, token, 'booking'),
        new Promise<void>(resolve => window.setTimeout(resolve, 1500)),
      ]);
      setBooking(result);
    } catch (e) { setError(e instanceof Error ? e.message : 'Booking failed. Please try again.'); }
    finally { setProcessing(false); }
  }

  if (booking && trackingInfo) return <Tracking token={token} booking={booking} onBack={onBack} />;
  if (booking) return <section className="booking-panel confirmation" aria-labelledby="confirmed-title">
    <div className="success-mark" aria-hidden="true">✓</div><h1 id="confirmed-title">Your Ride is Confirmed!</h1>
    <p>Simulation only. No driver has been dispatched and no payment was charged.</p>
    <dl><dt>Pickup</dt><dd>{booking.pickup.name}</dd><dt>Destination</dt><dd>{booking.destination.name}</dd><dt>Vehicle</dt><dd>{booking.vehicle.name}</dd><dt>Payment</dt><dd>{methods.find(([id]) => id === booking.payment)?.[1]}</dd><dt>Total fare</dt><dd>{rupees(booking.vehicle.fare)}</dd></dl>
    {booking.payment === 'cash' && <p className="notice">Cash is due at destination in this simulation; no real cash is collected.</p>}
    <p className="small">Booking reference: {booking.id}</p>
    <button className="primary" onClick={() => setTrackingInfo(true)}>Track Your Ride</button>

    <button className="text-button" onClick={onBack}>Choose another destination</button>
  </section>;

  return <section className="booking-panel" aria-labelledby="booking-title">
    <button className="text-button" onClick={onBack} disabled={processing}>← Change destination</button>
    <div className="card-kicker">YOUR SIMULATED RIDE</div><h1 id="booking-title">Choose a ride</h1>
    <p><strong>From:</strong> {start.name}<br/><strong>To:</strong> {destination.name}</p>
    {loading && <p role="status">Getting your estimate…</p>}
    {error && <div className="alert" role="alert">{error} {!quote && <button onClick={() => setRetry(n => n + 1)}>Retry estimate</button>}</div>}
    {quote && <>
      <p>Estimated road distance: <strong>{quote.distance_km.toFixed(2)} km</strong> (straight-line distance × 1.4; not live routing).</p>
      <p>Base: ₹30 for the first 3 km, then ₹5/km. Each vehicle has a disclosed fixed tier fee. No other fees; no cancellation fee.</p>
      {quote.surge_multiplier > 1 && <p className="surge">⚡ 1.1× simulated demand surge: fares are 10% higher in Hyderabad.</p>}
      <fieldset className="vehicle-list"><legend>Vehicle</legend>{quote.vehicles.map(item => <label className="vehicle-option" key={item.id}>
        <input type="radio" name="vehicle" value={item.id} checked={vehicle === item.id} onChange={() => setVehicle(item.id)} />
        <span className="vehicle-symbol" aria-hidden="true">{icons[item.id]}</span><span><strong>{item.name}</strong><small>{descriptions[item.id]}{item.seats ? ` · ${item.seats} ${item.seats === 1 ? 'seat' : 'seats'}` : ''}<br/>Estimated pickup {item.eta_minutes} min · Tier fee {rupees(item.tier_fee)}</small></span>
        <span className="vehicle-price">{quote.surge_multiplier > 1 && <del>{rupees(item.original_fare)}</del>}<strong>{rupees(item.fare)}</strong></span>
      </label>)}</fieldset>
      {vehicle === 'parcel' && <fieldset className="parcel-fields"><legend>Parcel details</legend>
        <label htmlFor="package-type">Package type</label><select id="package-type" value={parcel.package_type} onChange={e => { const package_type = e.target.value as Parcel['package_type']; setParcel(p => ({...p, package_type, courier_vehicle: package_type === 'medium_box' ? 'auto_car' : p.courier_vehicle})); }}><option value="document">Document</option><option value="small_box">Small Box under 5 kg</option><option value="medium_box">Medium Box under 15 kg</option><option value="fragile">Fragile</option></select>
        <label htmlFor="courier-vehicle">Courier vehicle</label><select id="courier-vehicle" value={parcel.courier_vehicle} onChange={e => setParcel(p => ({...p, courier_vehicle: e.target.value as Parcel['courier_vehicle']}))}><option value="two_wheeler" disabled={parcel.package_type === 'medium_box'}>Two-wheeler</option><option value="auto_car">Auto/Car</option></select>
        <label htmlFor="recipient">Recipient name</label><input id="recipient" maxLength={100} value={parcel.recipient_name} onChange={e => setParcel(p => ({...p, recipient_name: e.target.value}))} />
        <label htmlFor="recipient-phone">Recipient phone</label><input id="recipient-phone" type="tel" maxLength={16} value={parcel.recipient_phone} onChange={e => setParcel(p => ({...p, recipient_phone: e.target.value}))} />
        <label htmlFor="instructions">Pickup and drop-off instructions (optional)</label><input id="instructions" maxLength={500} value={parcel.instructions} onChange={e => setParcel(p => ({...p, instructions: e.target.value}))} />
      </fieldset>}
      <label htmlFor="payment-method">Payment method</label><select id="payment-method" value={payment} onChange={e => setPayment(e.target.value)}>{methods.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select>
      <p className="small">All methods are simulated. No card details or UPI IDs are collected, no wallet is debited, and no payment is processed. {payment === 'cash' ? 'Cash is due at destination in the simulation.' : ''}</p>
      <button className="primary" disabled={processing} onClick={() => void confirm()}>Confirm simulated booking · {rupees(quote.vehicles.find(item => item.id === vehicle)?.fare ?? 0)}</button>
    </>}
    {processing && <div className="processing" role="status" aria-live="polite"><div className="spinner" aria-hidden="true"/><strong>Processing simulated booking…</strong><p>No real payment is being made.</p></div>}
  </section>;
}
