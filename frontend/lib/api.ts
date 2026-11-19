export type Profile = { id: string; first_name: string; last_name: string; phone: string; email: string; photo: string; rating: number; method: string };
export type Session = { token: string; profile: Profile };
export type Location = { name: string; lat: number; lng: number };
export type SavedPlace = Location & { id: string; label: string };
export type LocationPage<T> = { items: T[]; total: number };
export type VehicleQuote = { id: string; name: string; seats: number | null; tier_fee: number; eta_minutes: number; base_fare: number; original_fare: number; fare: number };
export type Quote = { id: string; pickup: Location; destination: Location; distance_km: number; surge_multiplier: number; vehicles: VehicleQuote[] };
export type Parcel = { package_type: 'document' | 'small_box' | 'medium_box' | 'fragile'; recipient_name: string; recipient_phone: string; instructions: string; courier_vehicle: 'two_wheeler' | 'auto_car' };
export type RideBooking = { id: string; quote_id: string; pickup: Location; destination: Location; distance_km: number; surge_multiplier: number; vehicle: VehicleQuote; payment: string; status: string; created_at: string; parcel: Parcel | null };
export type TrackingState = { booking: RideBooking; state: string; driver: { name: string; rating: number; trips: number; model: string; plate: string } | null; pin: string | null; attempts: number; arrival_seconds: number; seconds_to_arrival: number; matching_seconds: number; progress: number };
export type Feedback = { rating: number; compliments: string[]; tip_paise: number };
export type HistoryRide = RideBooking & { feedback: Feedback | null };
export type Receipt = HistoryRide & { breakdown: { base_and_distance: number; tier_fee: number; time: number; surge: number; discount: number; total: number } };
export type Schedule = { id: string; kind: 'reserve' | 'hourly'; scheduled_at: string; pickup: Location; destination: Location; vehicle: VehicleQuote; distance_km: number; surge_multiplier: number; status: string };

/** Distinguish a network outage from an API rejection. */
export class NetworkError extends Error {}

/** Call the same-origin Next proxy and surface safe API errors. */
export async function api<T>(path: string, options: RequestInit = {}, token?: string, namespace = 'identity'): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let response: Response;
  try { response = await fetch(`/api/v1/${namespace}${path}`, { ...options, headers }); }
  catch { throw new NetworkError('Unable to reach the service. Please try again.'); }
  if (!response.ok) {
    if (response.status === 401) throw new Error('Session or challenge expired. Please start again.');
    if (response.status === 422) throw new Error('Please check your details and try again.');
    let detail: unknown;
    try { detail = (await response.json()).detail; } catch { detail = undefined; }
    throw new Error(typeof detail === 'string' ? detail : 'Something went wrong. Please try again.');
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
