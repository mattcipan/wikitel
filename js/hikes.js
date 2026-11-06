// Randonnées autour d'un point : sites Geotrek en priorité, OpenStreetMap (Overpass) en complément.
// De Geotrek, on n'affiche que des faits (nom, distance, durée, dénivelé, départ) et un lien vers la
// fiche officielle : ni texte ni photo, rien n'est recopié ailleurs que dans le cache de l'appareil.
import { distanceKm } from './places.js';
import { readArea, writeArea } from './store.js';

const ENDPOINT = 'https://overpass-api.de/api/interpreter';
const TIMEOUT_MS = 90000;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RETRY_DELAYS_S = [5, 15];
const MAX_RETRY_WAIT_S = 30;
const SEARCH_RADII_KM = [15, 30];
const MIN_RESULTS = 3;
const MAX_RESULTS = 6;
const MIN_LENGTH_KM = 2;
const MAX_LENGTH_KM = 40;
const NATURE_MIN_KM = 10;
const LENGTH_MISMATCH = 0.3;

// Adresse du relais Cloudflare (voir relay/worker.js), pour les sources refusant l'accès direct.
const RELAY_URL = 'https://wikitel-relais.cloudflare-shorten309.workers.dev';
const SEARCH_LAT = 0.27; // environ 30 km
const SEARCH_LON = 0.38;
const MAX_SOURCES = 4;
const CLOSER_SCALE = 0.4; // environ 12 km
const GEOTREK_TIMEOUT_MS = 20000;
const GEOTREK_FIELDS = 'id,name,length_2d,duration,ascent,departure,departure_geom,route';
const CLOSED_ROUTE = /ferm[ée]|interdit|supprim/i;
// Les tracés et marques GR sont protégés par la FFRandonnée.
const GR_ROUTE = /\bGRP?\b|\bGR\s?\d|GR®/i;

export class HikesUnavailable extends Error {}

let sourcesFile;
function geotrekSources() {
  sourcesFile ??= fetch('data/geotrek-sources.json').then((res) => res.json()).then((data) => data.sources);
  return sourcesFile;
}

function geotrekUrl(source, bbox) {
  const practices = source.practices.join(',');
  if (!source.direct) {
    return `${RELAY_URL}/${source.key}?${new URLSearchParams({ in_bbox: bbox, practices })}`;
  }
  const params = new URLSearchParams({
    format: 'json', language: 'fr', page_size: 100, fields: GEOTREK_FIELDS, in_bbox: bbox, practices,
  });
  return `${source.api}/trek/?${params}`;
}

function bboxAround(center, scale = 1) {
  return {
    west: center.lon - SEARCH_LON * scale, south: center.lat - SEARCH_LAT * scale,
    east: center.lon + SEARCH_LON * scale, north: center.lat + SEARCH_LAT * scale,
  };
}

const bboxParam = ({ west, south, east, north }) => `${west},${south},${east},${north}`;

async function fetchTreks(source, bbox) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEOTREK_TIMEOUT_MS);
  try {
    const res = await fetch(geotrekUrl(source, bbox), { signal: controller.signal });
    if (!res.ok) throw new HikesUnavailable(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function treksFrom(source, center) {
  const first = await fetchTreks(source, bboxParam(bboxAround(center)));
  let treks = first.results ?? [];
  // Au-delà d'une page, les fiches suivent l'ordre alphabétique et des voisines manqueraient :
  // on complète avec une zone resserrée autour du centre.
  if ((first.count ?? 0) > treks.length) {
    const closer = await fetchTreks(source, bboxParam(bboxAround(center, CLOSER_SCALE))).catch(() => ({}));
    const known = new Set(treks.map((trek) => trek.id));
    treks = [...treks, ...(closer.results ?? []).filter((trek) => !known.has(trek.id))];
  }
  return treks.map((trek) => toGeotrekHike(trek, source, center)).filter(Boolean);
}

function toGeotrekHike(trek, source, center) {
  const lengthKm = (trek.length_2d ?? 0) / 1000;
  const [lon, lat] = trek.departure_geom ?? [];
  if (!trek.name || lat === undefined || CLOSED_ROUTE.test(trek.name) || GR_ROUTE.test(trek.name)) return null;
  if (lengthKm < MIN_LENGTH_KM || lengthKm > MAX_LENGTH_KM) return null;
  const nearestKm = distanceKm(center, { lat, lon });
  return {
    id: `${source.key}-${trek.id}`, kind: 'geotrek', name: trek.name, lengthKm, nearestKm, lat, lon,
    loop: source.loops.includes(trek.route), durationHours: trek.duration || null, ascent: trek.ascent || null,
    sourceName: source.name, url: `${source.site.replace(/\/$/, '')}/trek/${trek.id}`,
  };
}

async function geotrekHikes(center) {
  const window = bboxAround(center);
  const sources = (await geotrekSources())
    .filter((s) => s.direct || RELAY_URL)
    .filter((s) => s.bbox[0] <= window.east && s.bbox[2] >= window.west && s.bbox[1] <= window.north && s.bbox[3] >= window.south)
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_SOURCES);
  const answers = await Promise.allSettled(sources.map((source) => treksFrom(source, center)));
  return answers.flatMap((answer) => (answer.status === 'fulfilled' ? answer.value : []));
}

async function requestRoutes(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      body: new URLSearchParams({ data: query }),
      signal: controller.signal,
    });
    if (RETRYABLE_STATUS.has(res.status)) {
      const error = new HikesUnavailable(`HTTP ${res.status}`);
      error.retryable = true;
      error.retryAfter = Number(res.headers.get('Retry-After')) || 0;
      throw error;
    }
    if (!res.ok) throw new HikesUnavailable(`HTTP ${res.status}`);
    return (await res.json()).elements ?? [];
  } catch (err) {
    throw err instanceof HikesUnavailable ? err : new HikesUnavailable(err.message);
  } finally {
    clearTimeout(timer);
  }
}

async function queryRoutes(center, radiusKm) {
  // Les grands itinéraires nationaux (GR) sont exclus : on cherche des sorties à la journée.
  const query = `[out:json][timeout:60];relation["route"="hiking"]["network"!~"^(nwn|iwn)$"](around:${radiusKm * 1000},${center.lat},${center.lon});out geom;`;
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestRoutes(query);
    } catch (err) {
      // Ce serveur public renvoie assez souvent des erreurs passagères.
      const waitSeconds = err.retryAfter || RETRY_DELAYS_S[attempt];
      if (!err.retryable || !RETRY_DELAYS_S[attempt] || waitSeconds > MAX_RETRY_WAIT_S) throw err;
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
    }
  }
}

// Longueur calculée sur le tracé, et point du sentier le plus proche du centre.
function measure(route, center) {
  let lengthKm = 0;
  let nearest = null;
  let nearestKm = Infinity;
  for (const member of route.members ?? []) {
    if (member.type !== 'way') continue;
    const points = (member.geometry ?? []).filter(Boolean);
    points.forEach((point, index) => {
      if (index > 0) lengthKm += distanceKm(points[index - 1], point);
      const km = distanceKm(center, point);
      if (km < nearestKm) { nearestKm = km; nearest = point; }
    });
  }
  return { lengthKm, nearest, nearestKm };
}

function toHike(route, center) {
  const { name, distance, roundtrip } = route.tags ?? {};
  const { lengthKm, nearest, nearestKm } = measure(route, center);
  if (!name || !nearest || lengthKm < MIN_LENGTH_KM || lengthKm > MAX_LENGTH_KM) return null;
  // Une longueur très différente de celle annoncée signale un tracé incomplet.
  const declared = Number.parseFloat(distance);
  if (declared && Math.abs(declared - lengthKm) / declared > LENGTH_MISMATCH) return null;
  return {
    id: route.id, kind: 'osm', name, lengthKm, nearestKm, lat: nearest.lat, lon: nearest.lon, loop: roundtrip === 'yes',
  };
}

const appeal = (hike) => (hike.loop ? 1.5 : 0)
  + (hike.lengthKm >= 5 && hike.lengthKm <= 15 ? 1 : 0)
  - hike.nearestKm / 5;

function select(hikes) {
  const seen = new Set();
  const unique = hikes
    .filter((hike) => {
      // Un même itinéraire figure parfois chez plusieurs sources, à la ponctuation près.
      const key = hike.name.normalize('NFD').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => appeal(b) - appeal(a));
  const chosen = unique.slice(0, MAX_RESULTS);
  // Près d'une ville, les balades urbaines occupent tout : on garde une place pour une vraie sortie.
  if (chosen.length === MAX_RESULTS && !chosen.some((hike) => hike.lengthKm >= NATURE_MIN_KM)) {
    const longer = unique.slice(MAX_RESULTS).find((hike) => hike.lengthKm >= NATURE_MIN_KM);
    if (longer) chosen[MAX_RESULTS - 1] = longer;
  }
  return chosen;
}

export async function loadHikes(center) {
  const key = `hikes:${center.lat.toFixed(3)},${center.lon.toFixed(3)}`;
  const cached = readArea(key);
  if (cached) return cached;
  const fromGeotrek = await geotrekHikes(center).catch(() => []);
  let chosen = select(fromGeotrek);
  // OpenStreetMap est plus lent et moins détaillé : il ne sert qu'à combler un manque.
  if (chosen.length < MIN_RESULTS) {
    let fromOsm = [];
    try {
      for (const radius of SEARCH_RADII_KM) {
        const routes = await queryRoutes(center, radius);
        fromOsm = routes.map((route) => toHike(route, center)).filter(Boolean);
        if (select([...fromGeotrek, ...fromOsm]).length >= MIN_RESULTS) break;
      }
    } catch (err) {
      if (!chosen.length) throw err;
    }
    chosen = select([...fromGeotrek, ...fromOsm]);
  }
  writeArea(key, chosen);
  return chosen;
}
