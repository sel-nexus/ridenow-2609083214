export type Profile = { id: string; first_name: string; last_name: string; phone: string; email: string; photo: string; rating: number; method: string };
export type Session = { token: string; profile: Profile };
export type Location = { name: string; lat: number; lng: number };
export type SavedPlace = Location & { id: string; label: string };
export type LocationPage<T> = { items: T[]; total: number };

/** Call the same-origin Next proxy and surface safe API errors. */
export async function api<T>(path: string, options: RequestInit = {}, token?: string, namespace = 'identity'): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let response: Response;
  try { response = await fetch(`/api/v1/${namespace}${path}`, { ...options, headers }); }
  catch { throw new Error('Unable to reach the service. Please try again.'); }
  if (!response.ok) {
    if (response.status === 401) throw new Error('Session or challenge expired. Please start again.');
    if (response.status === 422) throw new Error('Please check your details and try again.');
    throw new Error('Something went wrong. Please try again.');
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
