// Restaurants et bars autour d'un point, depuis OpenStreetMap. Aucune note n'y figure :
// chaque fiche renvoie vers Google Maps pour consulter les avis.
import { distanceKm } from './places.js';
import { overpass } from './overpass.js';
import { readArea, writeArea } from './store.js';

const SEARCH_RADII_KM = [1.5, 20];
const MIN_RESULTS = 5;
const MAX_PER_KIND = 30;

const KINDS = {
  restaurant: { group: 'restaurant', label: 'Restaurant' },
  bar: { group: 'bar', label: 'Bar' },
  pub: { group: 'bar', label: 'Pub' },
  biergarten: { group: 'bar', label: 'Bar' },
  cafe: { group: 'bar', label: 'Café' },
};

const CUISINES = {
  african: 'africain', american: 'américain', argentinian: 'argentin', asian: 'asiatique', barbecue: 'barbecue',
  brasserie: 'brasserie', breakfast: 'petit-déjeuner', burger: 'burgers', chinese: 'chinois', crepe: 'crêpes',
  fish: 'poisson', french: 'français', greek: 'grec', ice_cream: 'glaces', indian: 'indien', international: 'international',
  italian: 'italien', japanese: 'japonais', kebab: 'kebab', korean: 'coréen', lebanese: 'libanais', local: 'cuisine locale',
  mediterranean: 'méditerranéen', mexican: 'mexicain', moroccan: 'marocain', pasta: 'pâtes', pizza: 'pizzas',
  portuguese: 'portugais', ramen: 'ramen', regional: 'cuisine régionale', salad: 'salades', sandwich: 'sandwichs',
  seafood: 'fruits de mer', spanish: 'espagnol', steak_house: 'viandes', sushi: 'sushis', tapas: 'tapas', tea: 'salon de thé',
  thai: 'thaïlandais', traditional: 'cuisine traditionnelle', turkish: 'turc', vegan: 'végan', vegetarian: 'végétarien',
  vietnamese: 'vietnamien', wine: 'vins',
};

const DAYS = { Mo: 'lun', Tu: 'mar', We: 'mer', Th: 'jeu', Fr: 'ven', Sa: 'sam', Su: 'dim', PH: 'fériés' };

function frenchCuisines(value) {
  const known = (value ?? '').split(';').map((part) => CUISINES[part.trim().toLowerCase()]).filter(Boolean);
  return [...new Set(known)].slice(0, 3).join(', ') || null;
}

// Les horaires trop complexes pour être traduits proprement ne sont pas affichés.
function frenchHours(value) {
  if (!value) return null;
  if (value.trim() === '24/7') return '24 h/24';
  const text = value
    .replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su|PH)\b/g, (day) => DAYS[day])
    .replace(/\b(off|closed)\b/gi, 'fermé')
    .replace(/\s*;\s*/g, ' · ')
    .replace(/,(?=\d)/g, ', ');
  const untranslated = text.replace(/lun|mar|mer|jeu|ven|sam|dim|fériés|fermé/g, '').replace(/[\d\s:,·+\-/]/g, '');
  return untranslated ? null : text;
}

// Les données viennent de contributeurs : seuls de vrais liens web sont acceptés.
function safeWebsite(value) {
  const first = value?.split(';')[0].trim();
  if (!first) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(first) ? first : `https://${first}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function toVenue(element, center) {
  const tags = element.tags ?? {};
  const kind = KINDS[tags.amenity];
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (!kind || !tags.name || lat === undefined) return null;
  const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
  return {
    id: `${element.type}-${element.id}`, name: tags.name, group: kind.group, label: kind.label, lat, lon,
    distanceKm: distanceKm(center, { lat, lon }), cuisine: frenchCuisines(tags.cuisine),
    hours: frenchHours(tags.opening_hours), website: safeWebsite(tags.website ?? tags['contact:website']),
    street: street || null, city: tags['addr:city'] ?? null,
  };
}

async function venuesWithin(center, radiusKm) {
  const query = `[out:json][timeout:60];nwr["amenity"~"^(restaurant|bar|pub|cafe|biergarten)$"]["name"](around:${radiusKm * 1000},${center.lat},${center.lon});out tags center;`;
  const elements = await overpass(query);
  return elements.map((element) => toVenue(element, center)).filter(Boolean).sort((a, b) => a.distanceKm - b.distanceKm);
}

// Une part fixe par catégorie, pour que les nombreux restaurants n'évincent pas les bars.
function select(venues) {
  const nearest = (group) => venues.filter((venue) => venue.group === group).slice(0, MAX_PER_KIND);
  return [...nearest('restaurant'), ...nearest('bar')].sort((a, b) => a.distanceKm - b.distanceKm);
}

export async function loadVenues(center) {
  const key = `venues:${center.lat.toFixed(3)},${center.lon.toFixed(3)}`;
  const cached = readArea(key);
  if (cached) return cached;
  let venues = [];
  for (const radiusKm of SEARCH_RADII_KM) {
    try {
      venues = await venuesWithin(center, radiusKm);
    } catch (err) {
      if (venues.length) return select(venues);
      throw err;
    }
    if (venues.length >= MIN_RESULTS) break;
  }
  const chosen = select(venues);
  writeArea(key, chosen);
  return chosen;
}
