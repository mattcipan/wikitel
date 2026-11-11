// Données de l'utilisateur, sur l'appareil. Chaque entrée porte son horodatage et un identifiant
// stable (langue:titre) pour permettre une fusion le jour où les comptes synchronisés arriveront.
const KEY = 'wikitel:v1';
const HISTORY_LIMIT = 200;

const defaults = () => ({
  history: [],
  favorites: [],
  trips: [],
  itinerary: [],
  progress: {},
  settings: { radiusKm: 5, rate: 1, voices: {}, theme: 'auto', rateResetToNormal: true, travelMode: 'walking' },
});

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    const base = defaults();
    if (!saved) return base;
    // L'ancienne vitesse par défaut (1,25×) était enregistrée comme un choix : on la remplace une seule fois.
    if (!saved.settings?.rateResetToNormal && saved.settings?.rate === 1.25) delete saved.settings.rate;
    return { ...base, ...saved, settings: { ...base.settings, ...saved.settings, rateResetToNormal: true } };
  } catch {
    return defaults();
  }
}

const data = load();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // Stockage plein ou bloqué (navigation privée) : l'appli reste utilisable pour cette session.
  }
}

export const articleId = (lang, title) => `${lang}:${title}`;

function entry(article) {
  const { lang, title, description = '', thumb = '', lat, lon } = article;
  const item = { id: articleId(lang, title), lang, title, description, thumb, at: Date.now() };
  if (Number.isFinite(lat) && Number.isFinite(lon)) Object.assign(item, { lat, lon });
  return item;
}

export const settings = () => data.settings;
export function updateSettings(patch) {
  Object.assign(data.settings, patch);
  save();
}

export const history = () => data.history;
export function addHistory(article) {
  const item = entry(article);
  data.history = [item, ...data.history.filter((h) => h.id !== item.id)].slice(0, HISTORY_LIMIT);
  save();
}
export function clearHistory() {
  data.history = [];
  data.progress = {};
  save();
}

export const favorites = () => data.favorites;
export const isFavorite = (lang, title) => data.favorites.some((f) => f.id === articleId(lang, title));
export function toggleFavorite(article) {
  const item = entry(article);
  const exists = data.favorites.some((f) => f.id === item.id);
  data.favorites = exists ? data.favorites.filter((f) => f.id !== item.id) : [item, ...data.favorites];
  save();
  return !exists;
}

// Les favoris enregistrés avant la carte n'ont pas de coordonnées : on les complète après coup.
// `null` signale un article sans coordonnées, pour ne pas le redemander.
export function setFavoriteCoords(found) {
  for (const favorite of data.favorites) {
    if (!(favorite.id in found)) continue;
    const point = found[favorite.id];
    if (point) Object.assign(favorite, { lat: point.lat, lon: point.lon });
    else favorite.noCoords = true;
  }
  save();
}

// Itinéraire de la carte : une liste d'étapes { id, name, lat, lon }, dans l'ordre de visite.
export const itinerary = () => data.itinerary;
export const inItinerary = (id) => data.itinerary.some((s) => s.id === id);
export function toggleStop({ id, name, lat, lon }) {
  const exists = inItinerary(id);
  data.itinerary = exists ? data.itinerary.filter((s) => s.id !== id) : [...data.itinerary, { id, name, lat, lon }];
  save();
  return !exists;
}
export function setItinerary(stops) {
  data.itinerary = stops;
  save();
}
export function moveStop(id, offset) {
  const stops = data.itinerary;
  const from = stops.findIndex((s) => s.id === id);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= stops.length) return;
  stops.splice(to, 0, stops.splice(from, 1)[0]);
  save();
}

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const touch = (trip) => { trip.updatedAt = Date.now(); save(); };

export const trips = () => data.trips;
export const trip = (id) => data.trips.find((t) => t.id === id);

export function createTrip(name) {
  const created = { id: newId(), name, cities: [], createdAt: Date.now(), updatedAt: Date.now() };
  data.trips = [created, ...data.trips];
  save();
  return created;
}

export function deleteTrip(id) {
  data.trips = data.trips.filter((t) => t.id !== id);
  save();
}

// Renvoie false si la ville fait déjà partie du voyage.
export function addCity(tripId, { lang, title, label, lat, lon }) {
  const target = trip(tripId);
  const id = articleId(lang, title);
  if (target.cities.some((c) => c.id === id)) return false;
  target.cities.push({ id, lang, title, label, lat, lon, at: Date.now() });
  touch(target);
  return true;
}

export function removeCity(tripId, cityId) {
  const target = trip(tripId);
  target.cities = target.cities.filter((c) => c.id !== cityId);
  touch(target);
}

export function moveCity(tripId, cityId, offset) {
  const { cities } = trip(tripId);
  const from = cities.findIndex((c) => c.id === cityId);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= cities.length) return;
  cities.splice(to, 0, cities.splice(from, 1)[0]);
  touch(trip(tripId));
}

export const progress = (id) => data.progress[id];
export function saveProgress(id, chunk, total) {
  if (chunk <= 0 || chunk >= total) delete data.progress[id];
  else data.progress[id] = { chunk, total, at: Date.now() };
  save();
}

// Cache de courte durée : évite de réinterroger Wikipédia à chaque ouverture au même endroit.
const CACHE_PREFIX = 'wikitel:area:';
const CACHE_TTL = 24 * 3600 * 1000;

export function readArea(key) {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_PREFIX + key));
    return cached && Date.now() - cached.at < CACHE_TTL ? cached.value : null;
  } catch {
    return null;
  }
}

export function writeArea(key, value) {
  const payload = JSON.stringify({ at: Date.now(), value });
  try {
    localStorage.setItem(CACHE_PREFIX + key, payload);
  } catch {
    // Plein : on repart de zéro plutôt que de gérer une éviction fine pour un simple cache.
    Object.keys(localStorage).filter((k) => k.startsWith(CACHE_PREFIX)).forEach((k) => localStorage.removeItem(k));
    try { localStorage.setItem(CACHE_PREFIX + key, payload); } catch { /* tant pis */ }
  }
}
