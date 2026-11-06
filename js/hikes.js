// Randonnées autour d'un point, depuis OpenStreetMap (Overpass). La source est isolée ici :
// un autre fournisseur n'aurait qu'à renvoyer les mêmes champs depuis `loadHikes`.
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

export class HikesUnavailable extends Error {}

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
    id: route.id, name, lengthKm, nearestKm, lat: nearest.lat, lon: nearest.lon, loop: roundtrip === 'yes',
  };
}

const appeal = (hike) => (hike.loop ? 1.5 : 0)
  + (hike.lengthKm >= 5 && hike.lengthKm <= 15 ? 1 : 0)
  - hike.nearestKm / 5;

function select(hikes) {
  const seen = new Set();
  const unique = hikes
    .filter((hike) => {
      const key = hike.name.toLowerCase();
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
  let chosen = [];
  for (const radius of SEARCH_RADII_KM) {
    const routes = await queryRoutes(center, radius);
    chosen = select(routes.map((route) => toHike(route, center)).filter(Boolean));
    if (chosen.length >= MIN_RESULTS) break;
  }
  writeArea(key, chosen);
  return chosen;
}
