// Données de l'utilisateur, sur l'appareil. Chaque entrée porte son horodatage et un identifiant
// stable (langue:titre) pour permettre une fusion le jour où les comptes synchronisés arriveront.
const KEY = 'wikitel:v1';
const HISTORY_LIMIT = 200;

const defaults = () => ({
  history: [],
  favorites: [],
  progress: {},
  settings: { radiusKm: 5, rate: 1, voices: {}, theme: 'auto' },
});

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    const base = defaults();
    return saved ? { ...base, ...saved, settings: { ...base.settings, ...saved.settings } } : base;
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
  const { lang, title, description = '', thumb = '' } = article;
  return { id: articleId(lang, title), lang, title, description, thumb, at: Date.now() };
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
