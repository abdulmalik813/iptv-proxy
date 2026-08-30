const UI_BASE = (process.env.NEXT_PUBLIC_UI_BASE_PATH || '/ui').replace(/\/$/, '');

export function apiPath(path: string) {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${UI_BASE}${normalized}`;
}

export async function readJson<T = Record<string, unknown>>(response: Response): Promise<T> {
  const raw = await response.text();
  if (!raw) return {} as T;

  try {
    return JSON.parse(raw) as T;
  } catch {
    return {
      success: false,
      error: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
    } as T;
  }
}
