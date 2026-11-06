// Découverte des lieux et des personnes autour d'un point, classés par thème.
import { wikipedia, wikidata, pool, chunk } from './api.js';
import { readArea, writeArea } from './store.js';

const F = { HISTOIRE: 1, CULTURE: 2, ARCHITECTURE: 4, SETTLEMENT: 8, ARTIST: 16 };

export const THEMES = [
  { id: 'histoire', label: 'Histoire', flag: F.HISTOIRE },
  { id: 'personnes', label: 'Personnes célèbres' },
  { id: 'architecture', label: 'Architecture', flag: F.ARCHITECTURE },
  { id: 'culture', label: 'Culture', flag: F.CULTURE },
];

const GEO_LIMIT = 200;
const HERITAGE_BONUS = 1.5;
const NON_ARTICLE_SITES = new Set(['commonswiki', 'metawiki', 'specieswiki', 'wikidatawiki', 'mediawikiwiki', 'sourceswiki', 'incubatorwiki']);

let typeTable;
async function typeFlags() {
  if (!typeTable) {
    typeTable = fetch('data/types.json').then((r) => r.json()).then((grouped) => {
      const table = new Map();
      for (const [flags, ids] of Object.entries(grouped)) for (const id of ids) table.set(`Q${id}`, Number(flags));
      return table;
    });
  }
  return typeTable;
}

export function distanceKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

const claimIds = (entity, property) => (entity.claims?.[property] ?? [])
  .map((claim) => claim.mainsnak?.datavalue?.value?.id)
  .filter(Boolean);

const wikiLinks = (entity) => Object.keys(entity.sitelinks ?? {})
  .filter((site) => site.endsWith('wiki') && !NON_ARTICLE_SITES.has(site)).length;

async function geosearch(lang, center, radiusKm) {
  const pages = [];
  let cont = {};
  // Les propriétés d'une même requête peuvent arriver sur plusieurs réponses.
  for (let round = 0; round < 4 && cont; round++) {
    const data = await wikipedia(lang, {
      action: 'query', generator: 'geosearch', ggscoord: `${center.lat}|${center.lon}`,
      ggsradius: Math.round(radiusKm * 1000), ggslimit: GEO_LIMIT,
      prop: 'coordinates|pageprops|info', ppprop: 'wikibase_item', colimit: 'max', ...cont,
    });
    for (const page of data?.query?.pages ?? []) {
      const known = pages.find((p) => p.pageid === page.pageid);
      if (known) Object.assign(known, page);
      else pages.push(page);
    }
    cont = data?.continue ?? null;
  }
  return pages
    .filter((p) => p.pageprops?.wikibase_item && p.coordinates?.[0])
    .map((p) => ({
      qid: p.pageprops.wikibase_item, title: p.title, length: p.length ?? 0,
      lat: p.coordinates[0].lat, lon: p.coordinates[0].lon, lang,
    }));
}

async function entities(ids, props) {
  const batches = await pool(chunk(ids, 50), (batch) => wikidata({ action: 'wbgetentities', props, ids: batch.join('|') }));
  return Object.assign({}, ...batches.map((b) => b?.entities ?? {}));
}

// Pays → langue de sa Wikipédia, via Wikidata (P37 langue officielle, P424 code Wikimedia).
async function localLanguage(country) {
  if (!country) return null;
  const langs = await wikidata({ action: 'wbgetclaims', entity: country, property: 'P37' });
  const langIds = (langs?.claims?.P37 ?? [])
    .sort((a, b) => (b.rank === 'preferred') - (a.rank === 'preferred'))
    .map((c) => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
  const codes = await Promise.all(langIds.slice(0, 4).map(async (id) => {
    const code = await wikidata({ action: 'wbgetclaims', entity: id, property: 'P424' });
    return code?.claims?.P424?.[0]?.mainsnak?.datavalue?.value;
  }));
  const found = codes.filter(Boolean);
  return found.includes('fr') ? 'fr' : found[0] ?? null;
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function classify(entity, table) {
  let flags = 0;
  for (const type of claimIds(entity, 'P31')) flags |= table.get(type) ?? 0;
  const heritage = Boolean(entity.claims?.P1435?.length);
  if (heritage) flags |= F.HISTOIRE;
  return { flags, heritage };
}

const interest = (place) => 2 * Math.log(place.links + 1) + 0.6 * Math.log(place.length + 1) + (place.heritage ? HERITAGE_BONUS : 0);
const VIEW_DAYS = 30;
const VIEW_ROUNDS = 12;

export const VIEW_GROUPS = [
  { min: 1000, label: 'Très consultés', hint: 'plus de 1 000 vues en 30 jours' },
  { min: 100, label: 'Assez consultés', hint: '100 à 1 000 vues en 30 jours' },
  { min: 0, label: 'Peu consultés', hint: 'moins de 100 vues en 30 jours' },
];

const cleanName = (title) => title.replace(/\s*\(.*\)$/, '');

// Ajoute photo et description, au dernier moment et seulement pour ce qui sera affiché.
export async function enrich(items, thumbSize = 240) {
  const byLang = new Map();
  for (const item of items) {
    if (item.thumb !== undefined) continue;
    if (!byLang.has(item.lang)) byLang.set(item.lang, []);
    byLang.get(item.lang).push(item);
  }
  await pool([...byLang].flatMap(([lang, list]) => chunk(list, 50).map((batch) => [lang, batch])), async ([lang, batch]) => {
    const data = await wikipedia(lang, {
      action: 'query', titles: batch.map((i) => i.title).join('|'), prop: 'pageimages|description',
      piprop: 'thumbnail', pithumbsize: thumbSize, pilimit: 50,
    });
    const pages = new Map((data?.query?.pages ?? []).map((p) => [p.title, p]));
    const renamed = new Map((data?.query?.normalized ?? []).map((n) => [n.from, n.to]));
    for (const item of batch) {
      const page = pages.get(renamed.get(item.title) ?? item.title);
      item.thumb = page?.thumbnail?.source ?? '';
      item.description ||= page?.description ?? '';
    }
  });
  return items;
}

async function viewsOfBatch(lang, batch, totals) {
  let cont = {};
  // L'API répartit les résultats d'un même lot sur plusieurs réponses.
  for (let round = 0; round < VIEW_ROUNDS && cont; round++) {
    const data = await wikipedia(lang, {
      action: 'query', titles: batch.join('|'), prop: 'pageviews', pvipdays: VIEW_DAYS, ...cont,
    });
    const renamed = new Map((data?.query?.normalized ?? []).map((n) => [n.to, n.from]));
    for (const page of data?.query?.pages ?? []) {
      if (!page.pageviews) continue;
      const total = Object.values(page.pageviews).reduce((sum, day) => sum + (day ?? 0), 0);
      totals.set(`${lang}:${renamed.get(page.title) ?? page.title}`, total);
    }
    cont = data?.continue ?? null;
  }
}

// Une seule édition par article pour rester comparable : celle du pays visité si elle existe.
const viewSource = (item, local) => (item.localTitle
  ? { lang: local, title: item.localTitle }
  : { lang: item.lang, title: item.title });

// Renseigne `views` sur chaque élément. Renvoie false si aucun chiffre n'a pu être obtenu.
export async function loadViews(items, local, cacheKey) {
  const cached = readArea(cacheKey);
  if (cached) {
    for (const item of items) item.views = cached[item.qid];
    return true;
  }
  const byLang = new Map();
  for (const item of items) {
    const { lang, title } = viewSource(item, local);
    if (!byLang.has(lang)) byLang.set(lang, []);
    byLang.get(lang).push(title);
  }
  const totals = new Map();
  const jobs = [...byLang].flatMap(([lang, titles]) => chunk(titles, 50).map((batch) => [lang, batch]));
  const results = await Promise.allSettled(jobs.map(([lang, batch]) => viewsOfBatch(lang, batch, totals)));
  if (!totals.size) return false;

  const saved = {};
  for (const item of items) {
    const { lang, title } = viewSource(item, local);
    item.views = totals.get(`${lang}:${title}`);
    saved[item.qid] = item.views;
  }
  // Un résultat partiel n'est pas gardé : le prochain chargement complétera les chiffres.
  if (results.every((r) => r.status === 'fulfilled')) writeArea(cacheKey, saved);
  return true;
}

export async function discoverPlaces(center, radiusKm, onStep = () => {}) {
  const key = `${center.lat.toFixed(3)},${center.lon.toFixed(3)},${radiusKm}`;
  const cached = readArea(key);
  if (cached) return cached;

  const table = await typeFlags();
  onStep('Interrogation de Wikipédia');
  const found = await geosearch('fr', center, radiusKm);
  // Sans résultat en français, l'anglais suffit à identifier le pays.
  const probe = found.length ? found : await geosearch('en', center, radiusKm);

  onStep('Classement des lieux');
  const sitePages = new Map();
  const remember = (list) => list.forEach((p) => { if (!sitePages.has(p.qid)) sitePages.set(p.qid, p); });
  remember(found);
  const known = await entities(probe.map((p) => p.qid), 'claims|sitelinks');
  const country = mostCommon(Object.values(known).flatMap((e) => claimIds(e, 'P17').slice(0, 1)));
  const local = (await localLanguage(country).catch(() => null)) ?? 'fr';

  let all = known;
  if (local !== 'fr') {
    onStep('Recherche en langue locale');
    const localFound = await geosearch(local, center, radiusKm).catch(() => []);
    remember(localFound);
    const missing = localFound.map((p) => p.qid).filter((q) => !known[q]);
    all = { ...known, ...(await entities(missing, 'claims|sitelinks')) };
  } else if (!found.length) {
    remember(probe);
  }

  const places = [];
  const settlements = [];
  for (const [qid, page] of sitePages) {
    const entity = all[qid];
    if (!entity) continue;
    const { flags, heritage } = classify(entity, table);
    const frTitle = entity.sitelinks?.frwiki?.title;
    const localTitle = entity.sitelinks?.[`${local}wiki`]?.title;
    const place = {
      qid, lat: page.lat, lon: page.lon, length: page.length, links: wikiLinks(entity), heritage, flags,
      lang: frTitle ? 'fr' : page.lang, title: frTitle ?? page.title, localTitle: localTitle ?? null,
    };
    place.score = interest(place);
    if (flags & F.SETTLEMENT) settlements.push(place);
    if (flags & (F.HISTOIRE | F.CULTURE | F.ARCHITECTURE)) places.push(place);
  }
  places.sort((a, b) => b.score - a.score);

  const nearby = settlements.filter((s) => distanceKm(center, s) <= 3);
  const main = (nearby.length ? nearby : settlements).sort((a, b) => b.links - a.links)[0];
  const value = {
    places, local, placeName: main ? cleanName(main.title) : null,
    settlements: settlements.sort((a, b) => b.links - a.links).slice(0, 4)
      .map(({ qid, title, lat, lon }) => ({ qid, name: cleanName(title), lat, lon })),
  };
  writeArea(key, value);
  return value;
}

// Le lieu intéressant le plus proche : le plus proche parmi la meilleure moitié du classement.
export function closestInteresting(places, center) {
  if (!places.length) return null;
  const pool_ = places.slice(0, Math.max(5, Math.ceil(places.length / 2)));
  return [...pool_].sort((a, b) => distanceKm(center, a) - distanceKm(center, b))[0];
}

const REASONS = [['P19', 'Naissance à'], ['P20', 'Décès à'], ['P551', 'A vécu à']];

// Les biographies n'ont pas de coordonnées : on passe par les lieux de naissance, décès et résidence.
export async function discoverPeople(settlements, local) {
  if (!settlements.length) return [];
  const key = `people:${settlements.map((s) => s.qid).join(',')}`;
  const cached = readArea(key);
  if (cached) return cached;

  const table = await typeFlags();
  const statements = settlements.flatMap((s) => REASONS.map(([p]) => `${p}=${s.qid}`)).join('|');
  const search = await wikidata({
    action: 'query', list: 'search', srnamespace: 0, srlimit: 50, srsort: 'incoming_links_desc',
    srsearch: `haswbstatement:P31=Q5 haswbstatement:"${statements}"`,
  });
  const ids = (search?.query?.search ?? []).map((r) => r.title);
  const found = await entities(ids, 'claims|sitelinks|descriptions');

  const people = [];
  for (const entity of Object.values(found)) {
    const frTitle = entity.sitelinks?.frwiki?.title;
    const localTitle = entity.sitelinks?.[`${local}wiki`]?.title;
    if (!frTitle && !localTitle) continue;
    let reason = '';
    let place = settlements[0];
    for (const [property, label] of REASONS) {
      const match = settlements.find((s) => claimIds(entity, property).includes(s.qid));
      if (match) { reason = `${label} ${match.name}`; place = match; break; }
    }
    let flags = 0;
    for (const job of claimIds(entity, 'P106')) flags |= table.get(job) ?? 0;
    people.push({
      qid: entity.id, kind: 'person', reason, lat: place.lat, lon: place.lon, length: 0,
      links: wikiLinks(entity), artist: Boolean(flags & F.ARTIST), score: 2 * Math.log(wikiLinks(entity) + 1),
      lang: frTitle ? 'fr' : local, title: frTitle ?? localTitle, localTitle: localTitle ?? null,
      description: entity.descriptions?.[frTitle ? 'fr' : local]?.value ?? entity.descriptions?.fr?.value ?? '',
    });
  }
  people.sort((a, b) => b.links - a.links);
  writeArea(key, people);
  return people;
}

export function inTheme(themeId, places, people) {
  if (themeId === 'personnes') return people;
  const theme = THEMES.find((t) => t.id === themeId);
  const matching = places.filter((p) => p.flags & theme.flag);
  return themeId === 'culture' ? [...matching, ...people.filter((p) => p.artist)] : matching;
}

export async function searchArticles(query, local) {
  const langs = local && local !== 'fr' ? ['fr', local] : ['fr'];
  const groups = await Promise.all(langs.map(async (lang) => {
    const data = await wikipedia(lang, {
      action: 'query', generator: 'prefixsearch', gpssearch: query, gpslimit: 8, gpsnamespace: 0,
      prop: 'pageimages|description|coordinates', piprop: 'thumbnail', pithumbsize: 160, pilimit: 8, colimit: 8,
    }).catch(() => null);
    return (data?.query?.pages ?? []).sort((a, b) => a.index - b.index).map((p) => ({
      lang, title: p.title, description: p.description ?? '', thumb: p.thumbnail?.source ?? '',
      lat: p.coordinates?.[0]?.lat, lon: p.coordinates?.[0]?.lon,
    }));
  }));
  return groups.flat();
}
