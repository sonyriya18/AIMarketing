/**
 * Typed API client. Same-origin cookies carry the session; writes send the CSRF token.
 * Errors keep the server's stable code, message, details, and request ID.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
    readonly requestId?: string,
    readonly retryable = false
  ) {
    super(message);
  }
}

let csrfToken = '';
export const setCsrfToken = (t: string) => {
  csrfToken = t;
};

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok && res.status !== 202) {
    const e = body?.error;
    throw new ApiError(e?.message || `Request failed (${res.status})`, res.status, e?.code || 'error', e?.details, e?.requestId, Boolean(e?.retryable));
  }
  if (!res.ok && res.status === 409 && body?.data) return body.data as T;
  return (body?.data ?? body) as T;
}

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { credentials: 'same-origin', signal, headers: { Accept: 'application/json' } });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError('Cannot reach the server. Check your connection.', 0, 'network', undefined, undefined, true);
  }
  return parse<T>(res);
}

export async function apiSend<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, opts: { allowConflictBody?: boolean } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrfToken },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Cannot reach the server. Nothing was saved.', 0, 'network', undefined, undefined, true);
  }
  if (opts.allowConflictBody && res.status === 409) {
    const j = await res.json().catch(() => null);
    if (j?.data) return j.data as T;
    throw new ApiError(j?.error?.message || 'Conflict', 409, j?.error?.code || 'conflict', j?.error?.details);
  }
  return parse<T>(res);
}

export async function apiUpload<T>(path: string, file: File): Promise<T> {
  const fd = new FormData();
  fd.append('file', file);
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrfToken }, body: fd });
  } catch {
    throw new ApiError('Cannot reach the server. The file was not uploaded.', 0, 'network', undefined, undefined, true);
  }
  return parse<T>(res);
}

/** Downloads a server-generated file (exports) through the authenticated session. */
export async function apiDownload(path: string, fallbackName: string) {
  const res = await fetch(`/api/v1${path}`, { credentials: 'same-origin' });
  if (!res.ok) {
    const j = await res.json().catch(() => null);
    throw new ApiError(j?.error?.message || 'Download failed', res.status, j?.error?.code || 'error');
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
