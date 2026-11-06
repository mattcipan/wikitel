// Récupère un article Wikipédia et le remet en forme pour Wikitel.
import { articleHtml, wikipedia, wikidata } from './api.js';

const ALLOWED_TAGS = new Set(`A ABBR B BDI BIG BLOCKQUOTE BR CAPTION CITE CODE COL COLGROUP DD DEL DETAILS DFN DIV DL DT EM
  FIGCAPTION FIGURE H1 H2 H3 H4 H5 H6 HR I IMG INS KBD LI MARK OL P PRE Q S SAMP SECTION SMALL SPAN STRONG SUB SUMMARY SUP
  TABLE TBODY TD TFOOT TH THEAD TIME TR U UL VAR WBR`.split(/\s+/));
const DROPPED_TAGS = 'script,style,link,meta,noscript,iframe,object,embed,form,input,button,select,textarea,audio,video,svg,math,base,title,head';
const ALLOWED_ATTRS = { A: ['href', 'title'], IMG: ['alt', 'width', 'height'], TD: ['colspan', 'rowspan'], TH: ['colspan', 'rowspan', 'scope'], OL: ['start'], '*': ['id', 'class', 'lang', 'dir'] };
const NOISE = '.mw-editsection,.hatnote,.noexcerpt,.homonymie,.navbox,.navbox-container,.ambox,.bandeau-niveau-modere,.bandeau-niveau-grave,.bandeau-portail,.bandeau-article,.metadata,.noprint,.mw-empty-elt,.mw-jump-link,.portail-gauche,#bandeau-portail,.autres-projets,.sisterproject,.mbox-small,.sister-box,.asbox';
const INFOBOX = '.infobox,.infobox_v2,.infobox_v3,.infobox-v3,.infobox-v2';
const SPECIAL_NAMESPACE = /^(Fichier|File|Image|Média|Media|Aide|Help|Catégorie|Category|Portail|Portal|Spécial|Special|Modèle|Template|Wikipédia|Wikipedia|Projet|Discussion|Talk|Utilisateur|User|Référence|Module):/i;
const APPENDIX_HEADING = /^(notes?\b|références?\b|bibliographie|annexes?|voir aussi|liens? externes?|sources?\b|articles? connexes?|references|external links|see also|further reading|bibliography|bibliografia|voci correlate|altri progetti|collegamenti esterni|einzelnachweise|weblinks|literatur|siehe auch|enlaces externos|referencias|véase también|bibliografía|ligações externas|referências)/i;

export const wikiRoute = (lang, title) => `#/wiki/${lang}/${encodeURIComponent(title)}`;

function secureUrl(url) {
  if (!url) return '';
  const absolute = url.startsWith('//') ? `https:${url}` : url;
  return /^https:\/\//.test(absolute) ? absolute : '';
}

function unwrap(el) {
  el.replaceWith(...el.childNodes);
}

function cleanAttributes(el) {
  const allowed = new Set([...(ALLOWED_ATTRS[el.tagName] ?? []), ...ALLOWED_ATTRS['*']]);
  for (const attr of [...el.attributes]) if (!allowed.has(attr.name)) el.removeAttribute(attr.name);
}

function rewriteImage(img) {
  // `src` est lu avant le nettoyage ; une image hors HTTPS est retirée.
  const src = secureUrl(img.getAttribute('src'));
  cleanAttributes(img);
  if (!src) return img.remove();
  img.setAttribute('src', src);
  img.setAttribute('loading', 'lazy');
  img.setAttribute('decoding', 'async');
}

function rewriteLink(a, lang, title) {
  const href = a.getAttribute('href') ?? '';
  const rel = a.getAttribute('rel') ?? '';
  cleanAttributes(a);
  const base = `https://${lang}.wikipedia.org/wiki/`;

  if (href.startsWith('./') && !a.querySelector('img') && !a.classList.contains('new')) {
    const [rawTarget, fragment] = href.slice(2).split('#');
    const target = decodeURIComponent(rawTarget.split('?')[0]).replace(/_/g, ' ');
    if (target.replace(/_/g, ' ') === title && fragment) {
      a.setAttribute('href', `#${fragment}`);
      a.dataset.inpage = fragment;
      return;
    }
    if (!SPECIAL_NAMESPACE.test(target) && rel.includes('mw:WikiLink')) {
      a.setAttribute('href', wikiRoute(lang, target));
      return;
    }
    a.setAttribute('href', base + href.slice(2));
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
    return;
  }
  // Lien vers un article qui n'existe pas : il reste en texte simple.
  if (a.classList.contains('new') || href.includes('redlink=1')) return unwrap(a);
  if (href.startsWith('./')) {
    a.setAttribute('href', base + href.slice(2));
  } else if (href.startsWith('#')) {
    a.dataset.inpage = href.slice(1);
    return;
  } else {
    const url = secureUrl(href);
    if (!url && !href.startsWith('http://')) return unwrap(a);
    a.setAttribute('href', url || href);
  }
  a.setAttribute('target', '_blank');
  a.setAttribute('rel', 'noopener noreferrer');
}

function sanitize(root, lang, title) {
  root.querySelectorAll(DROPPED_TAGS).forEach((el) => el.remove());
  root.querySelectorAll(NOISE).forEach((el) => el.remove());
  for (const el of [...root.querySelectorAll('*')]) {
    if (!el.isConnected) continue;
    if (!ALLOWED_TAGS.has(el.tagName)) { unwrap(el); continue; }
    if (el.tagName === 'IMG') rewriteImage(el);
    else if (el.tagName === 'A') rewriteLink(el, lang, title);
    else cleanAttributes(el);
  }
}

function layout(root) {
  // Tableaux défilables, pour ne jamais élargir la page sur mobile.
  root.querySelectorAll('table').forEach((table) => {
    if (table.closest(INFOBOX) && !table.matches(INFOBOX)) return;
    const wrap = root.ownerDocument.createElement('div');
    wrap.className = 'table-wrap';
    table.replaceWith(wrap);
    wrap.append(table);
  });

  // L'infobox devient une fiche repliable, placée après le chapeau.
  const box = root.querySelector(INFOBOX);
  if (box) {
    const holder = box.closest('.table-wrap') ?? box;
    const fiche = root.ownerDocument.createElement('details');
    fiche.className = 'fiche';
    fiche.innerHTML = '<summary>Fiche</summary>';
    holder.replaceWith(fiche);
    fiche.append(holder);
    const firstParagraph = [...root.querySelectorAll('p')].find((p) => p.textContent.trim().length > 40);
    if (firstParagraph) firstParagraph.after(fiche);
  }

  // Notes, bibliographie, etc. : repliées, et jamais lues à voix haute.
  root.querySelectorAll('section').forEach((section) => {
    const heading = section.querySelector(':scope > h2');
    if (!heading || !APPENDIX_HEADING.test(heading.textContent.trim())) return;
    const appendix = root.ownerDocument.createElement('details');
    appendix.className = 'annexe';
    const summary = root.ownerDocument.createElement('summary');
    summary.textContent = heading.textContent;
    appendix.append(summary);
    heading.remove();
    section.replaceWith(appendix);
    appendix.append(section);
  });
  root.querySelectorAll('.mw-references-wrap').forEach((el) => el.classList.add('references'));
}

export function outline(root) {
  return [...root.querySelectorAll('h2')]
    .filter((h) => !h.closest('.annexe,.fiche') && h.textContent.trim())
    .map((heading, index) => {
      heading.id ||= `wikitel-section-${index}`;
      return { id: heading.id, label: heading.textContent.trim() };
    });
}

function metadata(data, title) {
  const page = data?.query?.pages?.[0];
  if (!page || page.missing) return { title };
  return {
    title: page.title,
    description: page.description ?? '',
    thumb: page.thumbnail?.source ?? '',
    lat: page.coordinates?.[0]?.lat,
    lon: page.coordinates?.[0]?.lon,
    qid: page.pageprops?.wikibase_item,
  };
}

async function otherVersions(qid, lang, local) {
  if (!qid) return [];
  const wanted = [...new Set(['fr', local].filter((code) => code && code !== lang))];
  if (!wanted.length) return [];
  const data = await wikidata({ action: 'wbgetentities', ids: qid, props: 'sitelinks', sitefilter: wanted.map((c) => `${c}wiki`).join('|') }).catch(() => null);
  const links = data?.entities?.[qid]?.sitelinks ?? {};
  return wanted.filter((code) => links[`${code}wiki`]).map((code) => ({ lang: code, title: links[`${code}wiki`].title }));
}

export async function loadArticle(lang, requestedTitle, local) {
  const [html, meta] = await Promise.all([
    articleHtml(lang, requestedTitle),
    wikipedia(lang, {
      action: 'query', titles: requestedTitle, redirects: 1, prop: 'coordinates|pageprops|pageimages|description',
      ppprop: 'wikibase_item', piprop: 'thumbnail', pithumbsize: 960,
    }).catch(() => null),
  ]);
  if (html === null) return null;

  const info = metadata(meta, requestedTitle);
  // Retirés avant l'analyse pour éviter une erreur CSP par style en console ; `sanitize` reste la vraie barrière.
  const withoutStyles = html.replace(/<head[\s\S]*?<\/head>/i, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/\sstyle="[^"]*"/gi, '');
  const doc = new DOMParser().parseFromString(withoutStyles, 'text/html');
  const root = doc.body;
  sanitize(root, lang, info.title);
  layout(root);
  const sections = outline(root);
  const versions = await otherVersions(info.qid, lang, local);
  return { ...info, lang, html: root.innerHTML, sections, versions };
}

const SENTENCE_LIMIT = 180;

function splitForSpeech(text) {
  const sentences = text.match(/[^.!?…]+[.!?…]*[»"”)]*\s*/g) ?? [text];
  const parts = [];
  for (const sentence of sentences) {
    if (sentence.length <= SENTENCE_LIMIT) { parts.push(sentence.trim()); continue; }
    let rest = sentence;
    while (rest.length > SENTENCE_LIMIT) {
      const window = rest.slice(0, SENTENCE_LIMIT);
      const cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(' : '));
      const at = cut > 40 ? cut + 1 : window.lastIndexOf(' ') || SENTENCE_LIMIT;
      parts.push(rest.slice(0, at).trim());
      rest = rest.slice(at);
    }
    parts.push(rest.trim());
  }
  // Regroupe les petites phrases : la voix enchaîne mieux qu'en s'arrêtant à chacune.
  const merged = [];
  for (const part of parts.filter(Boolean)) {
    const last = merged[merged.length - 1];
    if (last && last.length + part.length < SENTENCE_LIMIT) merged[merged.length - 1] = `${last} ${part}`;
    else merged.push(part);
  }
  return merged;
}

// Texte à lire : les paragraphes et titres, sans fiche, tableaux, légendes, notes ni annexes.
export function narrationChunks(root, title) {
  const chunks = [{ text: title, el: null }];
  const skip = '.fiche,.annexe,table,figure,.references,.toc,blockquote .reference';
  for (const el of root.querySelectorAll('h2,h3,h4,p,li')) {
    if (el.closest(skip)) continue;
    if (el.tagName === 'P' && el.closest('li')) continue;
    if (el.tagName === 'LI' && el.parentElement.closest('li')) continue;
    const clone = el.cloneNode(true);
    clone.querySelectorAll('sup,.reference,.mw-ref,.API,style').forEach((node) => node.remove());
    const text = clone.textContent.replace(/\[\s*\d+\s*\]/g, '').replace(/\s+/g, ' ').trim();
    if (text.length < 2) continue;
    for (const part of splitForSpeech(text)) chunks.push({ text: part, el });
  }
  return chunks;
}
