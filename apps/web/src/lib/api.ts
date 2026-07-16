import { auth } from '@/lib/firebase/config';

// Client -> our API.
//
// Every request carries a bearer token, because every route handler requires
// one. There is no unauthenticated path into this API, which is the single
// biggest difference from ML Studio: its four Reddit routes and its invitation
// relay accept anonymous calls from anyone on the internet.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const user = auth.currentUser;
  if (!user) throw new ApiError(401, 'You are not signed in.');

  const token = await user.getIdToken();

  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    // Fall through: a non-JSON body from an error page shouldn't mask the status.
  }

  if (!res.ok) {
    const message =
      (payload as { error?: string } | null)?.error ?? `Request failed (${res.status}).`;
    throw new ApiError(res.status, message);
  }

  return payload as T;
}

export const apiGet = <T>(path: string) => apiFetch<T>(path);

export const apiPost = <T>(path: string, body: unknown) =>
  apiFetch<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const apiPatch = <T>(path: string, body: unknown) =>
  apiFetch<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
