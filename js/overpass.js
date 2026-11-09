// Accès au serveur public Overpass, qui interroge OpenStreetMap.
const ENDPOINT = 'https://overpass-api.de/api/interpreter';
const TIMEOUT_MS = 90000;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RETRY_DELAYS_S = [5, 15];
const MAX_RETRY_WAIT_S = 30;

export class OverpassUnavailable extends Error {}

async function request(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      body: new URLSearchParams({ data: query }),
      signal: controller.signal,
    });
    if (RETRYABLE_STATUS.has(res.status)) {
      const error = new OverpassUnavailable(`HTTP ${res.status}`);
      error.retryable = true;
      error.retryAfter = Number(res.headers.get('Retry-After')) || 0;
      throw error;
    }
    if (!res.ok) throw new OverpassUnavailable(`HTTP ${res.status}`);
    return (await res.json()).elements ?? [];
  } catch (err) {
    throw err instanceof OverpassUnavailable ? err : new OverpassUnavailable(err.message);
  } finally {
    clearTimeout(timer);
  }
}

export async function overpass(query) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request(query);
    } catch (err) {
      // Ce serveur public renvoie assez souvent des erreurs passagères.
      const waitSeconds = err.retryAfter || RETRY_DELAYS_S[attempt];
      if (!err.retryable || !RETRY_DELAYS_S[attempt] || waitSeconds > MAX_RETRY_WAIT_S) throw err;
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
    }
  }
}
