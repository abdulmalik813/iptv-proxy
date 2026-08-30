import { LogService } from './log.service';

export async function refreshGoProviderRegistry(): Promise<boolean> {
  const token = process.env.INTERNAL_API_TOKEN?.trim();
  if (!token) return false;
  try {
    const response = await fetch('http://127.0.0.1:8080/internal/providers/refresh', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error(`Go core returned HTTP ${response.status}`);
    }
    return true;
  } catch (error) {
    await LogService.warn('provider', 'registry_refresh_failed', 'Provider changes were saved, but the Go registry could not be refreshed immediately.', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
