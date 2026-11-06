import { THEMES, VIEW_GROUPS, RADII_KM, discoverWithWidening, discoverPeople, closestInteresting, distanceKm, enrich, inTheme, isCity, loadViews, searchArticles } from './places.js';
import { loadArticle, narrationChunks, wikiRoute } from './article.js';
import { Narrator, speechSupported, voicesFor, preferredVoice, speakSample, onVoicesReady } from './speech.js';
import { articleUrl } from './api.js';
import * as store from './store.js';

const PAGE_SIZE = 12;
const view = document.getElementById('view');
const playerSlot = document.getElementById('player-slot');

const state = {
  center: null, // { lat, lon, label, source: 'gps' | 'manual' }
  status: 'idle', // idle | locating | loading | ready | denied | error
  step: '',
  area: null,
  usedRadiusKm: null,
  people: null,
  tab: 'histoire',
  sort: 'views', // views | near
  placeViews: 'loading', // loading | ready | failed
  peopleViews: 'loading',
  shown: PAGE_SIZE,
  requestId: 0,
};
let narrator = null;
let currentArticle = null;
const scrollByRoute = new Map();
let currentRoute = '';

const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function formatDistance(km) {
  if (km < 1) return `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m`;
  return `${km.toFixed(1).replace('.', ',')} km`;
}

const numberFormat = new Intl.NumberFormat('fr-FR');
const formatViews = (views) => `${numberFormat.format(views)} ${views > 1 ? 'vues' : 'vue'}`;

/* ---------- Localisation et chargement ---------- */

function locate() {
  if (!navigator.geolocation) {
    state.status = 'denied';
    return renderIfHome();
  }
  state.status = 'locating';
  renderIfHome();
  navigator.geolocation.getCurrentPosition(
    (pos) => setCenter({ lat: pos.coords.latitude, lon: pos.coords.longitude, source: 'gps' }),
    () => { state.status = 'denied'; renderIfHome(); },
    { enableHighAccuracy: false, timeout: 12000, maximumAge: 60000 },
  );
}

export async function setCenter(center) {
  state.center = center;
  state.area = null;
  state.people = null;
  state.placeViews = 'loading';
  state.peopleViews = 'loading';
  state.shown = PAGE_SIZE;
  const requestId = ++state.requestId;
  state.status = 'loading';
  state.step = 'Connexion à Wikipédia';
  renderIfHome();
  try {
    const { area, radiusKm } = await discoverWithWidening(center, store.settings().radiusKm, (step) => { state.step = step; renderIfHome(); });
    if (requestId !== state.requestId) return;
    state.area = area;
    state.usedRadiusKm = radiusKm;
    const hero = closestInteresting(area.places, center);
    if (hero) await enrich([hero], 640).catch(() => {});
    await enrich(area.places.slice(0, 50)).catch(() => {});
    if (requestId !== state.requestId) return;
    state.status = 'ready';
    renderIfHome();
    const areaKey = `${center.lat.toFixed(3)},${center.lon.toFixed(3)},${radiusKm}`;
    // Consultations et personnalités arrivent après : elles ne doivent pas retarder les lieux.
    loadViews(area.places, area.local, `views:${areaKey}`)
      .catch(() => false)
      .then((ok) => { if (requestId === state.requestId) { state.placeViews = ok ? 'ready' : 'failed'; renderIfHome(); } });
    discoverPeople(area.settlements, area.local)
      .then((people) => enrich(people.slice(0, 50)).catch(() => {}).then(() => people))
      .then(async (people) => {
        if (requestId !== state.requestId) return;
        state.people = people;
        renderIfHome();
        const ok = await loadViews(people, area.local, `people-views:${areaKey}`).catch(() => false);
        if (requestId === state.requestId) { state.peopleViews = ok ? 'ready' : 'failed'; renderIfHome(); }
      })
      .catch(() => { if (requestId === state.requestId) { state.people = []; state.peopleViews = 'failed'; renderIfHome(); } });
  } catch {
    if (requestId === state.requestId) { state.status = 'error'; renderIfHome(); }
  }
}

function renderIfHome() {
  if (currentRoute === '#/') renderHome();
}

/* ---------- Accueil ---------- */

// Pour un article sans image : son initiale, sans tenir compte de l'article (« Le », « La »…).
function initialOf(title) {
  const name = title.replace(/^(le|la|les|l['’])\s*/i, '');
  return (name.match(/\p{L}|\p{N}/u)?.[0] ?? '?').toUpperCase();
}

function initialBlock(title, tone = 'neutral') {
  return `<span class="initial initial-${esc(tone)}" aria-hidden="true">${esc(initialOf(title))}</span>`;
}

function itemCard(item) {
  const km = state.center && item.kind !== 'person' ? distanceKm(state.center, item) : null;
  const place = item.kind === 'person' ? item.reason : formatDistance(km);
  const meta = item.views === undefined ? place : `${place} · ${formatViews(item.views)}`;
  const image = item.thumb
    ? `<img src="${esc(item.thumb)}" alt="" loading="lazy" decoding="async">`
    : initialBlock(item.title, state.tab);
  return `<li><a class="card" href="${esc(wikiRoute(item.lang, item.title))}">
    <span class="card-img">${image}</span>
    <span class="card-body">
      <span class="card-title">${esc(item.title)}</span>
      ${item.description ? `<span class="card-desc">${esc(item.description)}</span>` : ''}
      <span class="card-meta">${esc(meta)}${item.lang !== 'fr' ? ` · en ${esc(languageName(item.lang))}` : ''}</span>
    </span>
  </a></li>`;
}

// La ville explorée : celle choisie, ou la commune principale autour de la position GPS.
function currentPlace() {
  const { center, area } = state;
  if (center?.title) return { lang: center.lang, title: center.title, label: center.label, lat: center.lat, lon: center.lon };
  const main = area?.mainPlace;
  return main ? { lang: 'fr', title: main.name, label: main.name, lat: main.lat, lon: main.lon } : null;
}

function statusLine() {
  const { center, area } = state;
  if (!center) return '';
  const chosen = store.settings().radiusKm;
  const radius = (area && state.usedRadiusKm) || chosen;
  const widened = radius !== chosen ? ' <span class="widened">(élargi automatiquement)</span>' : '';
  const place = center.label ?? area?.placeName ?? 'votre position';
  const article = center.title ? `<a href="${esc(wikiRoute(center.lang, center.title))}">Lire l'article</a>` : '';
  const addToTrip = currentPlace() ? '<button class="linkish" data-action="trip-sheet" type="button">Ajouter à un voyage</button>' : '';
  const back = center.source === 'manual' ? `${article} <button class="linkish" data-action="use-gps" type="button">Revenir à ma position</button>` : '';
  return `<p class="status"><span class="dot" aria-hidden="true"></span>Autour de <strong>${esc(place)}</strong> · <a href="#/reglages">${radius} km</a>${widened} ${addToTrip} ${back}</p>`;
}

function loadingScreen(message) {
  return `<div class="screen-msg" role="status"><p class="pixel">${esc(message)}<span class="cursor" aria-hidden="true"></span></p></div>`;
}

function themeList() {
  const { places } = state.area;
  const people = state.people ?? [];
  const tabs = THEMES.map((theme) => {
    const pending = !state.people && (theme.id === 'personnes' || theme.id === 'culture');
    const count = inTheme(theme.id, places, people).length;
    const selected = state.tab === theme.id;
    return `<button class="tab tab-${theme.id}" role="tab" type="button" aria-selected="${selected}" data-action="tab" data-tab="${theme.id}">
      ${esc(theme.label)} <span class="tab-count">${pending && theme.id === 'personnes' ? '…' : count}</span></button>`;
  }).join('');

  const isPeople = state.tab === 'personnes';
  const needed = isPeople ? [state.peopleViews] : state.tab === 'culture' ? [state.placeViews, state.peopleViews] : [state.placeViews];
  const viewsLoading = needed.includes('loading');
  const viewsFailed = !viewsLoading && needed.includes('failed');
  const grouped = !viewsLoading && !viewsFailed && (isPeople || state.sort === 'views');

  // Une biographie fait bien plus de vues qu'un musée : dans Culture, les lieux passent d'abord.
  const artistsLast = (a, b) => (isPeople ? 0 : (a.kind === 'person') - (b.kind === 'person'));
  let items = inTheme(state.tab, places, people);
  if (!isPeople && state.sort === 'near') {
    items = [...items].sort((a, b) => artistsLast(a, b) || distanceKm(state.center, a) - distanceKm(state.center, b));
  } else if (grouped) {
    items = [...items].sort((a, b) => artistsLast(a, b) || (b.views ?? -1) - (a.views ?? -1));
  }
  const visible = items.slice(0, state.shown);
  // Photos chargées à la demande, au fil de la pagination.
  const missing = visible.filter((i) => i.thumb === undefined);
  if (missing.length) enrich(missing).then(renderIfHome).catch(() => {});

  let body;
  if (isPeople && !state.people) body = loadingScreen('Recherche des personnalités');
  else if (!items.length) body = '<p class="empty">Rien dans ce thème pour ce périmètre. Essayez d\'élargir le rayon dans les réglages.</p>';
  else {
    const list = grouped ? viewGroups(items, visible, !isPeople) : `<ul class="cards">${visible.map(itemCard).join('')}</ul>`;
    const note = isPeople || state.sort === 'views'
      ? (viewsLoading ? '<p class="views-note" role="status">Chargement des consultations…</p>'
        : viewsFailed ? '<p class="views-note" role="status">Consultations indisponibles pour le moment : classement par intérêt.</p>' : '')
      : '';
    body = `${note}${list}
      ${items.length > state.shown ? '<button class="key key-wide" data-action="more" type="button">SUITE</button>' : ''}`;
  }
  const sorter = isPeople ? '' : `<div class="sorter" role="group" aria-label="Ordre d'affichage">
      <button type="button" data-action="sort" data-sort="views" aria-pressed="${state.sort === 'views'}">Les plus consultés</button>
      <button type="button" data-action="sort" data-sort="near" aria-pressed="${state.sort === 'near'}">Les plus proches</button>
    </div>`;
  return `<div class="tabs" role="tablist" aria-label="Thèmes">${tabs}</div>${sorter}<div class="tab-panel" role="tabpanel">${body}</div>`;
}

// `items` est trié par consultations ; `visible` en est le début, selon la pagination.
function viewGroups(items, visible, separateArtists) {
  const isArtist = (item) => separateArtists && item.kind === 'person';
  const section = (title, hint, shown) => (shown.length
    ? `<section class="view-group"><h2 class="group-title">${esc(title)}<span class="group-hint">${esc(hint)}</span></h2>
      <ul class="cards">${shown.map(itemCard).join('')}</ul></section>`
    : '');
  const groupOf = (item) => (item.views === undefined ? null : VIEW_GROUPS.find((g) => item.views >= g.min));
  const byViews = [...VIEW_GROUPS, null].map((group) => {
    const matches = (item) => !isArtist(item) && groupOf(item) === group;
    const total = items.filter(matches).length;
    return section(
      group ? group.label : 'Consultations inconnues',
      group ? `${group.hint} · ${total}` : String(total),
      visible.filter(matches),
    );
  });
  const artists = section('Artistes', `liés à ce périmètre, du plus consulté au moins consulté · ${items.filter(isArtist).length}`, visible.filter(isArtist));
  return byViews.join('') + artists;
}

function heroBlock() {
  const hero = closestInteresting(state.area.places, state.center);
  if (!hero) return '';
  const image = hero.thumb ? `<img src="${esc(hero.thumb)}" alt="" decoding="async">` : initialBlock(hero.title, 'hero');
  return `<section aria-label="Le lieu intéressant le plus proche">
    <a class="hero" href="${esc(wikiRoute(hero.lang, hero.title))}">
      <span class="hero-img">${image}</span>
      <span class="hero-text">
        <span class="hero-kicker">LE PLUS PROCHE · ${esc(formatDistance(distanceKm(state.center, hero)))}</span>
        <span class="hero-title">${esc(hero.title)}</span>
        ${hero.description ? `<span class="hero-desc">${esc(hero.description)}</span>` : ''}
      </span>
    </a>
  </section>`;
}

function renderHome() {
  document.title = 'Wikitel';
  const { status } = state;
  if (status === 'idle' || status === 'locating') {
    view.innerHTML = loadingScreen('Localisation en cours');
  } else if (status === 'loading') {
    view.innerHTML = statusLine() + loadingScreen(state.step);
  } else if (status === 'denied') {
    view.innerHTML = `<div class="screen-msg">
      <h1 class="pixel">OÙ ÊTES-VOUS ?</h1>
      <p>Wikitel n'a pas accès à votre position. Cherchez une ville pour explorer les lieux autour d'elle.</p>
      <div class="key-row">
        <button class="key" type="button" data-action="focus-search">CHERCHER UNE VILLE</button>
        <button class="key key-quiet" type="button" data-action="use-gps">RÉESSAYER</button>
      </div>
    </div>`;
  } else if (status === 'error') {
    view.innerHTML = `<div class="screen-msg">
      <h1 class="pixel">PAS DE CONNEXION</h1>
      <p>Impossible de joindre Wikipédia pour le moment. Vérifiez votre réseau, puis réessayez.</p>
      <button class="key" type="button" data-action="retry">RÉESSAYER</button>
    </div>`;
  } else if (!state.area.places.length) {
    view.innerHTML = `${statusLine()}<div class="screen-msg">
      <h1 class="pixel">RIEN ICI</h1>
      <p>Wikipédia ne recense aucun lieu marquant, même à ${state.usedRadiusKm} km.</p>
      <a class="key" href="#/reglages">RÉGLAGES</a>
    </div>`;
  } else {
    view.innerHTML = `<div class="home">${statusLine()}${heroBlock()}${themeList()}</div>`;
  }
}

/* ---------- Article ---------- */

function stopNarrator() {
  narrator?.destroy();
  narrator = null;
  playerSlot.innerHTML = '';
  document.body.classList.remove('has-player');
  view.querySelector('.speaking')?.classList.remove('speaking');
}

let lastManualScroll = 0;
['wheel', 'touchmove'].forEach((type) => addEventListener(type, () => { lastManualScroll = Date.now(); }, { passive: true }));

function followNarration(n) {
  const element = n.chunks[n.index]?.el;
  const previous = view.querySelector('.speaking');
  if (previous !== element) {
    previous?.classList.remove('speaking');
    element?.classList.add('speaking');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (element && n.state === 'playing' && Date.now() - lastManualScroll > 8000) {
      element.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
    }
  }
}

function renderPlayer(n) {
  const playing = n.state === 'playing';
  const voiceMissing = voicesFor(n.lang).length === 0 && window.speechSynthesis.getVoices().length > 0;
  const message = n.state === 'error'
    ? 'La lecture s\'est interrompue. Appuyez sur lecture pour reprendre.'
    : n.state === 'ended' ? 'Fin de la lecture.'
    : voiceMissing ? `Aucune voix « ${n.lang} » sur cet appareil : la lecture peut mal sonner.` : '';
  const rate = store.settings().rate;
  playerSlot.innerHTML = `<div class="player" role="region" aria-label="Lecture audio">
    <progress max="${n.chunks.length}" value="${n.index + 1}" aria-label="Avancement de la lecture"></progress>
    ${message ? `<p class="player-msg" role="status">${esc(message)}</p>` : ''}
    <div class="player-row">
      <button class="icon-btn" type="button" data-action="tts-prev" aria-label="Paragraphe précédent">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h2v14H6zm14 0v14L9 12z"/></svg></button>
      <button class="play" type="button" data-action="tts-toggle" aria-label="${playing ? 'Mettre en pause' : 'Lire'}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${playing ? 'M7 5h4v14H7zm6 0h4v14h-4z' : 'M7 4v16l13-8z'}"/></svg></button>
      <button class="icon-btn" type="button" data-action="tts-next" aria-label="Paragraphe suivant">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg></button>
      <button class="rate" type="button" data-action="tts-rate" aria-label="Vitesse de lecture : ${rate} fois">${String(rate).replace('.', ',')}×</button>
      <button class="icon-btn" type="button" data-action="tts-close" aria-label="Fermer le lecteur">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z"/></svg></button>
    </div>
  </div>`;
}

function startNarration() {
  const article = currentArticle;
  const root = view.querySelector('.article-body');
  const chunks = narrationChunks(root, article.title);
  const id = store.articleId(article.lang, article.title);
  const saved = store.progress(id);
  const start = saved && saved.total === chunks.length ? saved.chunk : 0;
  stopNarrator();
  document.body.classList.add('has-player');
  narrator = new Narrator({
    chunks,
    lang: article.lang,
    start,
    getOptions: () => ({ rate: store.settings().rate, voiceUri: store.settings().voices[article.lang] }),
    onChange: (n) => {
      if (n !== narrator) return;
      store.saveProgress(id, n.index, n.chunks.length);
      followNarration(n);
      renderPlayer(n);
      updateListenButton();
    },
  });
  narrator.play();
}

function updateListenButton() {
  const button = view.querySelector('[data-action="listen"]');
  if (!button || !currentArticle) return;
  const saved = store.progress(store.articleId(currentArticle.lang, currentArticle.title));
  button.textContent = saved ? `REPRENDRE L'ÉCOUTE · ${Math.round((saved.chunk / saved.total) * 100)} %` : 'ÉCOUTER';
}

function languageName(code) {
  try {
    return new Intl.DisplayNames(['fr'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

function renderArticle(article) {
  const favorite = store.isFavorite(article.lang, article.title);
  const hasCoords = article.lat !== undefined && article.lon !== undefined;
  const versions = article.versions.map((v) => `<a class="key key-quiet" href="${esc(wikiRoute(v.lang, v.title))}">LIRE EN ${esc(languageName(v.lang).toUpperCase())}</a>`).join('');
  const noFrench = article.lang !== 'fr' && !article.versions.some((v) => v.lang === 'fr');
  view.innerHTML = `<article class="article" lang="${esc(article.lang)}">
    <div class="article-keys" lang="fr">
      <button class="key key-quiet" type="button" data-action="back">RETOUR</button>
      <button class="key key-quiet" type="button" data-action="favorite" aria-pressed="${favorite}">${favorite ? '★ FAVORI' : '☆ FAVORI'}</button>
    </div>
    ${article.thumb ? `<img class="article-lead" src="${esc(article.thumb)}" alt="" decoding="async">` : ''}
    <h1>${esc(article.title)}</h1>
    ${article.description ? `<p class="article-desc">${esc(article.description)}</p>` : ''}
    <div class="article-actions" lang="fr">
      ${speechSupported() ? '<button class="key" type="button" data-action="listen">ÉCOUTER</button>' : ''}
      ${hasCoords ? `<a class="key key-quiet" target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/dir/?api=1&amp;destination=${article.lat},${article.lon}">Y ALLER</a>
      <button class="key key-quiet" type="button" data-action="explore">EXPLORER AUTOUR</button>` : ''}
      ${versions}
    </div>
    ${noFrench ? '<p class="notice" lang="fr">Cet article n\'existe pas encore en français. La traduction automatique arrivera dans une prochaine version.</p>' : ''}
    ${article.sections.length ? `<details class="toc" lang="fr"><summary>Sommaire de l'article</summary><ol>${article.sections.map((s) => `<li><a href="#${esc(s.id)}" data-inpage="${esc(s.id)}" lang="${esc(article.lang)}">${esc(s.label)}</a></li>`).join('')}</ol></details>` : ''}
    <div class="article-body">${article.html}</div>
    <footer class="credits" lang="fr">
      Texte issu de l'article <a href="${esc(articleUrl(article.lang, article.title))}" target="_blank" rel="noopener noreferrer">« ${esc(article.title)} »</a>
      de Wikipédia, par ses contributeurs, sous licence
      <a href="https://creativecommons.org/licenses/by-sa/4.0/deed.fr" target="_blank" rel="noopener noreferrer">CC BY-SA 4.0</a>.
      Mise en forme adaptée par Wikitel. Touchez une image pour voir son auteur et sa licence.
    </footer>
  </article>`;
  // Sur grand écran, la fiche tient dans la marge : autant la laisser ouverte.
  const fiche = view.querySelector('.fiche');
  if (fiche && matchMedia('(min-width: 62em)').matches) fiche.open = true;
  updateListenButton();
}

async function openArticle(lang, title) {
  view.innerHTML = loadingScreen('Chargement de l\'article');
  currentArticle = null;
  const route = currentRoute;
  try {
    const article = await loadArticle(lang, title, state.area?.local);
    if (route !== currentRoute) return;
    if (!article) {
      view.innerHTML = `<div class="screen-msg"><h1 class="pixel">PAGE INTROUVABLE</h1><p>Cet article n'existe pas sur Wikipédia.</p><a class="key" href="#/">SOMMAIRE</a></div>`;
      return;
    }
    currentArticle = article;
    document.title = `${article.title} · Wikitel`;
    renderArticle(article);
    store.addHistory(article);
    const fragment = scrollByRoute.get(route);
    if (fragment) scrollTo(0, fragment);
  } catch {
    if (route !== currentRoute) return;
    view.innerHTML = `<div class="screen-msg"><h1 class="pixel">PAS DE CONNEXION</h1><p>L'article n'a pas pu être chargé. Il n'est pas disponible hors connexion.</p><button class="key" data-action="reload-route" type="button">RÉESSAYER</button></div>`;
  }
}

function jumpInPage(id) {
  const target = document.getElementById(id);
  if (!target) return;
  for (let parent = target.parentElement; parent; parent = parent.parentElement) {
    if (parent.tagName === 'DETAILS') parent.open = true;
  }
  target.scrollIntoView({ block: 'start' });
  target.classList.add('flash');
  setTimeout(() => target.classList.remove('flash'), 1600);
}

/* ---------- Listes et réglages ---------- */

const backKey = '<div class="page-keys"><button class="key key-quiet" type="button" data-action="back">RETOUR</button></div>';

const seePlacesLabel = () => `VOIR LES LIEUX · ${store.settings().radiusKm} KM`;

function renderStoredList(title, items, emptyMessage, footer = '') {
  document.title = `${title} · Wikitel`;
  view.innerHTML = `<div class="page">${backKey}<h1 class="pixel">${esc(title.toUpperCase())}</h1>
    ${items.length ? `<ul class="cards">${items.map((item) => `<li><a class="card" href="${esc(wikiRoute(item.lang, item.title))}">
      <span class="card-img">${item.thumb ? `<img src="${esc(item.thumb)}" alt="" loading="lazy" decoding="async">` : initialBlock(item.title)}</span>
      <span class="card-body"><span class="card-title">${esc(item.title)}</span>
      ${item.description ? `<span class="card-desc">${esc(item.description)}</span>` : ''}
      <span class="card-meta">${new Date(item.at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}</span></span></a></li>`).join('')}</ul>${footer}`
    : `<p class="empty">${esc(emptyMessage)}</p>`}</div>`;
}

function radioGroup(name, legend, options, current) {
  return `<fieldset class="field"><legend>${esc(legend)}</legend><div class="choices">${options.map(([value, label]) => `
    <label class="choice"><input type="radio" name="${name}" value="${value}" ${String(value) === String(current) ? 'checked' : ''}><span>${esc(label)}</span></label>`).join('')}</div></fieldset>`;
}

const VOICE_SAMPLES = {
  fr: 'Bonjour, ici Wikitel. La prise de la Bastille a eu lieu le 14 juillet 1789.',
  it: 'Buongiorno, qui Wikitel. Roma fu fondata nel 753 avanti Cristo.',
  en: 'Hello, this is Wikitel. The Battle of Hastings took place on 14 October 1066.',
  de: 'Guten Tag, hier ist Wikitel. Die Berliner Mauer fiel am 9. November 1989.',
  es: 'Hola, aquí Wikitel. Colón llegó a América el 12 de octubre de 1492.',
};

function voiceField(lang) {
  const voices = voicesFor(lang);
  const name = languageName(lang);
  if (!voices.length) {
    return `<div class="field"><span class="legend">Voix (${esc(name)})</span>
      <p class="notice">Aucune voix en ${esc(name)} n'est détectée sur cet appareil : la lecture risque d'utiliser un mauvais accent.<br>
      Sur Android : Paramètres, puis recherchez « synthèse vocale », et installez les données de cette langue.<br>
      Sur iPhone : Réglages, Accessibilité, Contenu énoncé, Voix.</p></div>`;
  }
  const saved = store.settings().voices[lang] ?? '';
  const active = preferredVoice(lang, saved);
  return `<div class="field"><label><span class="legend">Voix (${esc(name)})</span>
    <select data-voice-lang="${esc(lang)}"><option value="">Automatique</option>
    ${voices.map((v) => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === saved ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select></label>
    <p class="voice-active">Voix utilisée : ${esc(active.name)} (${esc(active.lang)})</p>
    ${VOICE_SAMPLES[lang] ? `<button class="key key-quiet" type="button" data-action="test-voice" data-lang="${esc(lang)}">TESTER LA VOIX</button>` : ''}</div>`;
}

function renderSettings() {
  document.title = 'Réglages · Wikitel';
  const s = store.settings();
  const langs = [...new Set(['fr', state.area?.local].filter(Boolean))];
  view.innerHTML = `<div class="page page-narrow">${backKey}<h1 class="pixel">RÉGLAGES</h1>
    <p class="settings-note">Vos choix sont enregistrés automatiquement.</p>
    ${radioGroup('radius', 'Périmètre de recherche', RADII_KM.map((km) => [km, `${km} km`]), s.radiusKm)}
    ${radioGroup('rate', 'Vitesse de la voix', [[0.8, '0,8×'], [1, '1×'], [1.25, '1,25×'], [1.5, '1,5×']], s.rate)}
    ${speechSupported() ? langs.map(voiceField).join('') : '<p class="notice">La synthèse vocale n\'est pas disponible sur ce navigateur.</p>'}
    ${radioGroup('theme', 'Apparence', [['auto', 'Automatique'], ['light', 'Clair'], ['dark', 'Sombre']], s.theme)}
    <p class="legal">Version ${esc(loadedVersion ?? 'inconnue')}</p>
    <p class="legal">Votre position sert uniquement à chercher les lieux proches auprès de Wikipédia. Votre historique et vos favoris restent sur cet appareil.</p>
    <div class="page-done"><a class="key key-wide" id="see-places" href="#/">${esc(seePlacesLabel())}</a></div>
  </div>`;
}

/* ---------- Voyages ---------- */

function plural(count, word) {
  return `${count} ${word}${count > 1 ? 's' : ''}`;
}

function renderTrips() {
  document.title = 'Voyages · Wikitel';
  const trips = store.trips();
  view.innerHTML = `<div class="page page-narrow">${backKey}<h1 class="pixel">VOYAGES</h1>
    <div class="inline-field">
      <input id="new-trip-name" type="text" maxlength="60" placeholder="Nom du voyage, par exemple Italie 2027" aria-label="Nom du nouveau voyage" autocomplete="off" enterkeyhint="done">
      <button class="key" type="button" data-action="trip-create">CRÉER</button>
    </div>
    ${trips.length ? `<ul class="trips">${trips.map((t) => `<li><a class="trip-row" href="#/voyages/${esc(t.id)}">
      <span class="card-title">${esc(t.name)}</span>
      <span class="card-meta">${esc(plural(t.cities.length, 'ville'))}</span></a></li>`).join('')}</ul>`
    : '<p class="empty">Créez un voyage, puis ajoutez-y les villes de votre itinéraire.</p>'}</div>`;
}

// Google Maps accepte au plus 9 étapes intermédiaires en plus du départ et de l'arrivée.
function routeUrl(cities) {
  const point = (c) => `${c.lat},${c.lon}`;
  const stops = cities.slice(0, 11);
  const params = new URLSearchParams({ api: '1', origin: point(stops[0]), destination: point(stops[stops.length - 1]) });
  if (stops.length > 2) params.set('waypoints', stops.slice(1, -1).map(point).join('|'));
  return `https://www.google.com/maps/dir/?${params}`;
}

function renderTrip(id) {
  const trip = store.trip(id);
  if (!trip) {
    view.innerHTML = '<div class="screen-msg"><h1 class="pixel">VOYAGE INTROUVABLE</h1><p>Il a peut-être été supprimé.</p><a class="key" href="#/voyages">VOYAGES</a></div>';
    return;
  }
  document.title = `${trip.name} · Wikitel`;
  const last = trip.cities.length - 1;
  const rows = trip.cities.map((city, index) => `<li class="stop">
      <span class="stop-number" aria-hidden="true">${index + 1}</span>
      <button class="stop-name" type="button" data-action="trip-explore" data-city="${esc(city.id)}">${esc(city.label)}</button>
      <button class="icon-btn" type="button" data-action="trip-move" data-city="${esc(city.id)}" data-offset="-1" aria-label="Monter ${esc(city.label)}" ${index === 0 ? 'disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 7 7 8H5z"/></svg></button>
      <button class="icon-btn" type="button" data-action="trip-move" data-city="${esc(city.id)}" data-offset="1" aria-label="Descendre ${esc(city.label)}" ${index === last ? 'disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 17-7-8h14z"/></svg></button>
      <button class="icon-btn" type="button" data-action="trip-remove" data-city="${esc(city.id)}" aria-label="Retirer ${esc(city.label)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z"/></svg></button>
    </li>`).join('');
  const tooMany = trip.cities.length > 11 ? '<p class="legal">Google Maps limite l\'itinéraire aux 11 premières villes.</p>' : '';
  view.innerHTML = `<div class="page page-narrow" data-trip="${esc(trip.id)}">
    <div class="page-keys"><a class="key key-quiet" href="#/voyages">VOYAGES</a></div>
    <h1 class="pixel">${esc(trip.name.toUpperCase())}</h1>
    <div class="trip-search">
      <input id="trip-search-input" type="search" placeholder="Ajouter une ville…" aria-label="Rechercher une ville à ajouter" autocomplete="off" enterkeyhint="search">
      <div class="trip-results" id="trip-search-results" hidden></div>
    </div>
    <p class="views-note" id="trip-message" role="status"></p>
    ${rows ? `<ol class="stops">${rows}</ol>` : '<p class="empty">Aucune ville pour le moment. Cherchez-en une ci-dessus, ou utilisez « Ajouter à un voyage » depuis la page d\'une ville.</p>'}
    ${trip.cities.length > 1 ? `<a class="key key-wide" target="_blank" rel="noopener noreferrer" href="${esc(routeUrl(trip.cities))}">VOIR L'ITINÉRAIRE</a>${tooMany}` : ''}
    <button class="linkish danger" type="button" data-action="trip-delete">Supprimer ce voyage</button>
  </div>`;
}

let tripSearchTimer;
let tripSearchToken = 0;
let tripResults = [];

async function runTripSearch(query) {
  const token = ++tripSearchToken;
  const box = document.getElementById('trip-search-results');
  if (query.trim().length < 2) { box.hidden = true; return; }
  const results = (await searchArticles(query.trim(), state.area?.local)).filter((r) => r.lat !== undefined && r.qid);
  if (token !== tripSearchToken || !box.isConnected) return;
  tripResults = results;
  box.hidden = false;
  box.innerHTML = results.length
    ? results.map((r, i) => `<button class="trip-result" type="button" data-action="trip-add-result" data-index="${i}">
        <span class="result-title">${esc(r.title)}</span>${r.description ? `<span class="result-desc">${esc(r.description)}</span>` : ''}</button>`).join('')
    : '<p class="result-none">Aucun lieu trouvé.</p>';
}

const tripSheet = document.getElementById('trip-sheet');

function renderTripSheet(message = '') {
  const place = currentPlace();
  const trips = store.trips();
  tripSheet.innerHTML = `<h2 class="pixel">AJOUTER ${esc(place.label.toUpperCase())}</h2>
    ${message ? `<p class="notice" role="status">${message}</p>` : ''}
    ${trips.length ? `<div class="sheet-list">${trips.map((t) => `<button class="trip-result" type="button" data-action="trip-add-current" data-trip="${esc(t.id)}">
      <span class="result-title">${esc(t.name)}</span><span class="result-desc">${esc(plural(t.cities.length, 'ville'))}</span></button>`).join('')}</div>` : ''}
    <div class="inline-field">
      <input id="sheet-trip-name" type="text" maxlength="60" placeholder="Nouveau voyage" aria-label="Nom du nouveau voyage" autocomplete="off" enterkeyhint="done">
      <button class="key" type="button" data-action="trip-create-add">CRÉER</button>
    </div>
    <button class="key key-quiet key-wide" type="button" data-action="trip-sheet-close">FERMER</button>`;
}

function addedMessage(tripId, added) {
  const trip = store.trip(tripId);
  const name = esc(trip.name);
  return `${added ? 'Ajouté à' : 'Déjà dans'} <a href="#/voyages/${esc(tripId)}">${name}</a>.`;
}

function createTripFrom(input) {
  const name = input?.value.trim();
  if (!name) { input?.focus(); return null; }
  return store.createTrip(name);
}

function renderAccount() {
  document.title = 'Mon compte · Wikitel';
  view.innerHTML = `<div class="page page-narrow">${backKey}<h1 class="pixel">MON COMPTE</h1>
    <p>La connexion et la synchronisation entre appareils arriveront dans la prochaine version.</p>
    <p>En attendant, votre historique et vos favoris sont enregistrés sur cet appareil. Ils pourront être repris à votre première connexion.</p>
    <div class="key-row"><a class="key" href="#/historique">HISTORIQUE</a><a class="key key-quiet" href="#/favoris">FAVORIS</a></div></div>`;
}

async function openRandom() {
  view.innerHTML = loadingScreen('Tirage au sort');
  if (!state.center) {
    locate();
  }
  const started = Date.now();
  while (!['ready', 'denied', 'error'].includes(state.status) && Date.now() - started < 30000 && currentRoute === '#/hasard') {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (currentRoute !== '#/hasard') return;
  const candidates = [...(state.area?.places ?? []), ...(state.people ?? [])];
  if (!candidates.length) {
    view.innerHTML = `<div class="screen-msg"><h1 class="pixel">PÉRIMÈTRE INCONNU</h1><p>Il faut une position, ou une ville choisie, pour tirer un article au hasard.</p><a class="key" href="#/">SOMMAIRE</a></div>`;
    return;
  }
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  location.replace(wikiRoute(pick.lang, pick.title));
}

/* ---------- Routeur ---------- */

function route() {
  scrollByRoute.set(currentRoute, scrollY);
  stopNarrator();
  currentArticle = null;
  closeSearch();
  menu.close();
  document.getElementById('trip-sheet').close();
  const hash = location.hash || '#/';
  currentRoute = hash;
  const article = hash.match(/^#\/wiki\/([a-z-]+)\/(.+)$/);
  if (article) {
    scrollTo(0, 0);
    openArticle(article[1], decodeURIComponent(article[2]));
  } else {
    if (hash === '#/hasard') openRandom();
    else if (hash === '#/historique') renderStoredList('Historique', store.history(), 'Les articles que vous ouvrez apparaîtront ici.', '<button class="key key-quiet key-wide" type="button" data-action="clear-history">EFFACER L\'HISTORIQUE</button>');
    else if (hash === '#/favoris') renderStoredList('Favoris', store.favorites(), 'Ajoutez un article à vos favoris pour le retrouver ici.');
    else if (hash === '#/voyages') renderTrips();
    else if (hash.startsWith('#/voyages/')) renderTrip(hash.slice('#/voyages/'.length));
    else if (hash === '#/reglages') renderSettings();
    else if (hash === '#/compte') renderAccount();
    else if (hash === '#/') renderHome();
    else { const anchor = hash.slice(1); currentRoute = '#/'; history.replaceState(null, '', '#/'); renderHome(); jumpInPage(anchor); return; }
    scrollTo(0, scrollByRoute.get(hash) ?? 0);
  }
  view.focus({ preventScroll: true });
}

/* ---------- Menu et recherche ---------- */

const menu = document.getElementById('menu');
const searchBox = document.getElementById('search');
const searchInput = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');
const searchToggle = document.getElementById('search-toggle');
let searchTimer;
let searchToken = 0;
let lastResults = [];

function closeSearch() {
  searchBox.classList.remove('open');
  searchToggle.setAttribute('aria-expanded', 'false');
  searchResults.hidden = true;
}

function openSearch() {
  searchBox.classList.add('open');
  searchToggle.setAttribute('aria-expanded', 'true');
  searchInput.focus();
}

async function runSearch(query) {
  const token = ++searchToken;
  if (query.trim().length < 2) { searchResults.hidden = true; return; }
  const results = await searchArticles(query.trim(), state.area?.local);
  if (token !== searchToken) return;
  lastResults = results;
  searchResults.hidden = false;
  searchResults.innerHTML = results.length
    ? results.map((r, i) => `<div class="result">
        <a href="${esc(wikiRoute(r.lang, r.title))}" data-result="${i}"><span class="result-title">${esc(r.title)}</span>${r.description ? `<span class="result-desc">${esc(r.description)}</span>` : ''}</a>
        ${r.lat !== undefined ? `<button class="key key-quiet key-small" type="button" data-action="explore-result" data-index="${i}">EXPLORER</button>` : ''}
      </div>`).join('')
    : '<p class="result-none">Aucun résultat.</p>';
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(searchInput.value), 250);
});
searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { searchInput.value = ''; closeSearch(); }
});
searchToggle.addEventListener('click', () => (searchBox.classList.contains('open') ? closeSearch() : openSearch()));
document.getElementById('menu-open').addEventListener('click', () => menu.showModal());
document.getElementById('menu-close').addEventListener('click', () => menu.close());
menu.addEventListener('click', (event) => {
  if (event.target === menu) menu.close();
  // Un lien vers la page déjà ouverte ne déclenche pas le routeur.
  if (event.target.closest('a')) menu.close();
});

const placeLabel = (title) => title.replace(/\s*\(.*\)$/, '');

function exploreAt(lat, lon, title, lang) {
  location.hash = '#/';
  setCenter({ lat, lon, label: placeLabel(title), title, lang, source: 'manual' });
}

// Une ville mène à ce qu'il y a à y faire ; tout autre résultat ouvre son article.
async function openResult(result) {
  searchInput.value = '';
  closeSearch();
  const city = result.lat !== undefined && result.qid
    ? await isCity(result.qid).catch(() => false)
    : false;
  if (city) exploreAt(result.lat, result.lon, result.title, result.lang);
  else location.hash = wikiRoute(result.lang, result.title);
}

/* ---------- Actions ---------- */

const RATES = [0.8, 1, 1.25, 1.5];

const actions = {
  tab(el) { state.tab = el.dataset.tab; state.shown = PAGE_SIZE; renderHome(); },
  sort(el) { state.sort = el.dataset.sort; state.shown = PAGE_SIZE; renderHome(); },
  more() { state.shown += PAGE_SIZE; const y = scrollY; renderHome(); scrollTo(0, y); },
  retry() { if (state.center) setCenter(state.center); else locate(); },
  'use-gps'() { locate(); },
  'focus-search'() { openSearch(); },
  back() { if (history.length > 1) history.back(); else location.hash = '#/'; },
  favorite(el) {
    const on = store.toggleFavorite(currentArticle);
    el.setAttribute('aria-pressed', String(on));
    el.textContent = on ? '★ FAVORI' : '☆ FAVORI';
  },
  listen() { startNarration(); },
  explore() { exploreAt(currentArticle.lat, currentArticle.lon, currentArticle.title, currentArticle.lang); },
  'explore-result'(el) {
    const result = lastResults[Number(el.dataset.index)];
    searchInput.value = '';
    closeSearch();
    exploreAt(result.lat, result.lon, result.title, result.lang);
  },
  'tts-toggle'() { narrator?.toggle(); },
  'tts-prev'() { narrator?.skip(-1); },
  'tts-next'() { narrator?.skip(1); },
  'tts-close'() { stopNarrator(); updateListenButton(); },
  'tts-rate'() {
    const next = RATES[(RATES.indexOf(store.settings().rate) + 1) % RATES.length];
    store.updateSettings({ rate: next });
    narrator?.refresh();
    if (narrator) renderPlayer(narrator);
  },
  'clear-history'() {
    if (confirm('Effacer tout l\'historique ?')) { store.clearHistory(); route(); }
  },
  'test-voice'(el) {
    const { lang } = el.dataset;
    speakSample(VOICE_SAMPLES[lang], lang, { rate: store.settings().rate, voiceUri: store.settings().voices[lang] });
  },
  'reload-route'() { route(); },
  'trip-create'() {
    const created = createTripFrom(document.getElementById('new-trip-name'));
    if (created) location.hash = `#/voyages/${created.id}`;
  },
  'trip-sheet'() { renderTripSheet(); tripSheet.showModal(); },
  'trip-sheet-close'() { tripSheet.close(); },
  'trip-add-current'(el) {
    const added = store.addCity(el.dataset.trip, currentPlace());
    renderTripSheet(addedMessage(el.dataset.trip, added));
  },
  'trip-create-add'() {
    const created = createTripFrom(document.getElementById('sheet-trip-name'));
    if (!created) return;
    store.addCity(created.id, currentPlace());
    renderTripSheet(addedMessage(created.id, true));
  },
  async 'trip-add-result'(el) {
    const tripId = view.querySelector('[data-trip]').dataset.trip;
    const result = tripResults[Number(el.dataset.index)];
    const city = await isCity(result.qid).catch(() => false);
    if (!city) {
      document.getElementById('trip-message').textContent = `« ${result.title} » n'est pas reconnu comme une ville.`;
      return;
    }
    const added = store.addCity(tripId, { ...result, label: placeLabel(result.title) });
    renderTrip(tripId);
    if (!added) document.getElementById('trip-message').textContent = `${placeLabel(result.title)} fait déjà partie de ce voyage.`;
    document.getElementById('trip-search-input').focus();
  },
  'trip-explore'(el) {
    const trip = store.trip(view.querySelector('[data-trip]').dataset.trip);
    const city = trip.cities.find((c) => c.id === el.dataset.city);
    exploreAt(city.lat, city.lon, city.title, city.lang);
  },
  'trip-move'(el) {
    const tripId = view.querySelector('[data-trip]').dataset.trip;
    store.moveCity(tripId, el.dataset.city, Number(el.dataset.offset));
    renderTrip(tripId);
  },
  'trip-remove'(el) {
    const tripId = view.querySelector('[data-trip]').dataset.trip;
    store.removeCity(tripId, el.dataset.city);
    renderTrip(tripId);
  },
  'trip-delete'() {
    const tripId = view.querySelector('[data-trip]').dataset.trip;
    if (!confirm(`Supprimer le voyage « ${store.trip(tripId).name} » ?`)) return;
    store.deleteTrip(tripId);
    location.hash = '#/voyages';
  },
};

document.addEventListener('click', (event) => {
  const resultLink = event.target.closest('a[data-result]');
  if (resultLink) {
    event.preventDefault();
    openResult(lastResults[Number(resultLink.dataset.result)]);
    return;
  }
  const inPage = event.target.closest('a[data-inpage]');
  if (inPage) {
    event.preventDefault();
    jumpInPage(inPage.dataset.inpage);
    return;
  }
  const actionEl = event.target.closest('[data-action]');
  if (actionEl) actions[actionEl.dataset.action]?.(actionEl);
  if (!event.target.closest('#search')) closeSearch();
});

function applyTheme() {
  const { theme } = store.settings();
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = theme;
}

document.addEventListener('input', (event) => {
  if (event.target.id !== 'trip-search-input') return;
  clearTimeout(tripSearchTimer);
  tripSearchTimer = setTimeout(() => runTripSearch(event.target.value), 250);
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  if (event.target.id === 'new-trip-name') actions['trip-create']();
  if (event.target.id === 'sheet-trip-name') actions['trip-create-add']();
});

document.addEventListener('change', (event) => {
  const { name, value } = event.target;
  if (name === 'radius') {
    store.updateSettings({ radiusKm: Number(value) });
    document.getElementById('see-places').textContent = seePlacesLabel();
    // La liste change : on la rouvrira en haut, pas à l'ancienne position.
    scrollByRoute.delete('#/');
    if (state.center) setCenter(state.center);
  } else if (name === 'rate') {
    store.updateSettings({ rate: Number(value) });
  } else if (name === 'theme') {
    store.updateSettings({ theme: value });
    applyTheme();
  } else if (event.target.dataset.voiceLang) {
    const voices = { ...store.settings().voices, [event.target.dataset.voiceLang]: value };
    store.updateSettings({ voices });
    renderSettings();
  }
});

onVoicesReady(() => { if (currentRoute === '#/reglages') renderSettings(); });

/* ---------- Mises à jour ---------- */

// Sur mobile, revenir dans l'appli ne recharge pas la page : une nouvelle publication passerait inaperçue.
let loadedVersion = null;
const APP_FILES = ['index.html', 'css/styles.css', 'js/app.js', 'js/api.js', 'js/article.js', 'js/places.js', 'js/speech.js', 'js/store.js', 'data/types.json'];

async function publishedVersion() {
  try {
    const res = await fetch('version.json', { cache: 'no-cache' });
    return res.ok ? (await res.json()).version : null;
  } catch {
    return null;
  }
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  const latest = await publishedVersion();
  const listening = narrator?.state === 'playing';
  if (latest && loadedVersion && latest !== loadedVersion && !listening) {
    // Sans ce rafraîchissement préalable, le rechargement peut encore exécuter l'ancien code.
    await Promise.allSettled(APP_FILES.map((file) => fetch(file, { cache: 'no-cache' })));
    location.reload();
  }
});

/* ---------- Démarrage ---------- */

applyTheme();
publishedVersion().then((version) => {
  loadedVersion = version;
  if (currentRoute === '#/reglages') renderSettings();
});
addEventListener('hashchange', route);
route();
locate();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
