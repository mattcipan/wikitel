// Accès aux API Wikimedia. Pas de SPARQL ici : il est trop limité pour être appelé depuis l'appli.
const USER_AGENT = 'Wikitel/0.1';
const TIMEOUT_MS = 20000;
const MIN_RETRY_SECONDS = 5;
const MAX_RETRY_SECONDS = 15;
const MAX_CONCURRENT = 3;

export class NetworkError extends Error {}

// Wikimedia demande au plus 3 requêtes simultanées : la limite vaut pour toute l'appli.
let active = 0;
const waiting = [];

function acquire() {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else active -= 1;
}

async function fetchOnce(url, parse) {
  await acquire();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'Api-User-Agent': USER_AGENT } });
    if (res.status === 404) return null;
    if (res.status === 429 || res.status >= 500) {
      const error = new NetworkError(`HTTP ${res.status}`);
      error.retryAfter = Number(res.headers.get('Retry-After')) || 0;
      throw error;
    }
    if (!res.ok) throw new NetworkError(`HTTP ${res.status}`);
    return await parse(res);
  } finally {
    clearTimeout(timer);
    release();
  }
}

async function request(url, parse, attempt = 0) {
  try {
    return await fetchOnce(url, parse);
  } catch (err) {
    // Règles Wikimedia : respecter Retry-After, sinon attendre au moins 5 s.
    const waitSeconds = err.retryAfter || MIN_RETRY_SECONDS;
    if (attempt < 1 && waitSeconds <= MAX_RETRY_SECONDS) {
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
      return request(url, parse, attempt + 1);
    }
    throw err instanceof NetworkError ? err : new NetworkError(err.message);
  }
}

function actionUrl(host, params) {
  const query = new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...params });
  return `https://${host}/w/api.php?${query}`;
}

export const wikipedia = (lang, params) => request(actionUrl(`${lang}.wikipedia.org`, params), (r) => r.json());
export const wikidata = (params) => request(actionUrl('www.wikidata.org', params), (r) => r.json());

export function articleHtml(lang, title) {
  const path = encodeURIComponent(title.replace(/ /g, '_'));
  return request(`https://${lang}.wikipedia.org/api/rest_v1/page/html/${path}`, (r) => r.text());
}

export function articleUrl(lang, title) {
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

// Exécute `task` sur chaque élément avec une concurrence limitée, par égard pour les serveurs.
export async function pool(items, task, concurrency = 3) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  }));
  return results;
}

export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
