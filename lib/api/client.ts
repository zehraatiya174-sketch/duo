import { AppError, type ErrorCode, isErrorCode } from '@/lib/errors';

/**
 * Browser-side fetch wrapper.
 *
 * Every non-2xx response is turned into the same `AppError` the server threw,
 * so a component can branch on `error.code` instead of parsing status numbers,
 * and TanStack Query's retry predicate has something structured to inspect.
 */

interface ErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, string[]>;
  };
}

/** Fallback when a response carries no usable error body (proxy 502, HTML 500). */
function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 410:
      return 'GONE';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE';
    case 422:
      return 'VALIDATION_FAILED';
    case 429:
      return 'RATE_LIMITED';
    default:
      return 'INTERNAL';
  }
}

async function toAppError(response: Response): Promise<AppError> {
  let body: ErrorBody = {};
  try {
    body = (await response.json()) as ErrorBody;
  } catch {
    // A proxy or network appliance can return HTML for a 502; falling back to
    // the status code keeps the failure legible instead of throwing a parse
    // error over the real one.
  }

  const rawCode = body.error?.code;
  const code = isErrorCode(rawCode) ? rawCode : codeForStatus(response.status);
  const retryAfterHeader = response.headers.get('Retry-After');
  const retryAfter = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : undefined;

  return new AppError(code, body.error?.message ?? response.statusText ?? 'Request failed', {
    ...(body.error?.details ? { details: body.error.details } : {}),
    ...(retryAfter !== undefined && Number.isFinite(retryAfter) ? { retryAfter } : {}),
  });
}

export interface RequestOptions extends Omit<RequestInit, 'body' | 'method'> {
  /** Serialized as JSON unless it is already a `FormData`/`Blob`. */
  body?: unknown;
  searchParams?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
}

function buildUrl(path: string, searchParams: RequestOptions['searchParams']): string {
  if (!searchParams) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const { body, searchParams, headers, ...rest } = options;

  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
  const init: RequestInit = {
    method,
    // Cookies carry the session; without this the request is anonymous.
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      // Browsers never attach this to cross-site form posts, so its presence
      // is corroborating evidence that the caller is our own script.
      'X-Requested-With': 'fetch',
      ...(body !== undefined && !isFormData ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...rest,
  };

  if (body !== undefined) {
    init.body = isFormData ? (body as FormData) : JSON.stringify(body);
  }

  const response = await fetch(buildUrl(path, searchParams), init);

  if (!response.ok) {
    throw await toAppError(response);
  }

  if (response.status === 204 || response.headers.get('Content-Length') === '0') {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions): Promise<T> => request<T>('GET', path, options),
  post: <T>(path: string, options?: RequestOptions): Promise<T> =>
    request<T>('POST', path, options),
  patch: <T>(path: string, options?: RequestOptions): Promise<T> =>
    request<T>('PATCH', path, options),
  put: <T>(path: string, options?: RequestOptions): Promise<T> => request<T>('PUT', path, options),
  delete: <T>(path: string, options?: RequestOptions): Promise<T> =>
    request<T>('DELETE', path, options),
} as const;

/**
 * Uploads with progress. `fetch` cannot report upload progress, so this drops
 * to XHR — the one place in the client where that is worth the extra code.
 */
export function uploadWithProgress<T>(
  path: string,
  formData: FormData,
  handlers: {
    onProgress?: (percent: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const { onProgress, signal } = handlers;

  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path, true);
    xhr.withCredentials = true;
    xhr.responseType = 'json';
    xhr.setRequestHeader('X-Requested-With', 'fetch');

    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      onProgress?.(Math.round((event.loaded / event.total) * 100));
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response as T);
        return;
      }
      const body = xhr.response as ErrorBody | null;
      const rawCode = body?.error?.code;
      const code = isErrorCode(rawCode) ? rawCode : codeForStatus(xhr.status);
      reject(new AppError(code, body?.error?.message ?? 'Upload failed'));
    });

    xhr.addEventListener('error', () => {
      reject(new AppError('STORAGE_FAILED', 'Network error during upload'));
    });

    xhr.addEventListener('abort', () => {
      reject(new DOMException('Upload aborted', 'AbortError'));
    });

    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        return;
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }

    xhr.send(formData);
  });
}
