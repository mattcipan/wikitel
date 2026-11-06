// Relais Wikitel : fichier généré par tools/build_geotrek_sources.py, à déployer sur Cloudflare Workers.
// Il ne sert qu'à interroger des API Geotrek publiques qui refusent l'accès direct depuis un navigateur.
// Il impose la liste des sources, l'origine du site et des champs factuels : ni texte ni photo.
const SOURCES = {
  "geotrek-auvergnerhonealpes-tourisme-com": "https://geotrek.auvergnerhonealpes-tourisme.com/api/v2",
  "geotrek-cd05-aggregator-makina-corpus-net": "https://geotrek-cd05-aggregator.makina-corpus.net/api/v2",
  "geotrek-aggr-gard-fr": "https://geotrek-aggr.gard.fr/api/v2",
  "admin-rando-loire-atlantique-fr": "https://admin-rando.loire-atlantique.fr/api/v2",
  "geotrek-admin-le64-fr": "https://geotrek-admin.le64.fr/api/v2",
  "geotrekadmin-tarn-fr": "https://geotrekadmin.tarn.fr/api/v2",
  "gestion-sportnature-var-fr": "https://gestion-sportnature.var.fr/api/v2",
  "adminrando-marittimemercantour-eu": "https://adminrando.marittimemercantour.eu/api/v2",
  "geotrek-admin-portcros-parcnational-fr": "https://geotrek-admin.portcros-parcnational.fr/api/v2",
  "geotrek-perche-makina-corpus-net": "https://geotrek-perche.makina-corpus.net/api/v2",
  "admin-pilat-rando-fr": "https://admin.pilat-rando.fr/api/v2",
  "geotrek-parcdumorvan-org": "https://geotrek.parcdumorvan.org/api/v2",
  "adminrando-coeurcoteaux-comminges-fr": "https://adminrando.coeurcoteaux-comminges.fr/api/v2",
  "rando-admin-intercauxvexin-fr": "https://rando.admin.intercauxvexin.fr/api/v2",
  "geotrekadmin-compiegne-pierrefonds-fr": "https://geotrekadmin.compiegne-pierrefonds.fr/api/v2",
  "geotrek-sudviennepoitou-com": "https://geotrek.sudviennepoitou.com/api/v2"
};
const ALLOWED_ORIGINS = ['https://mattcipan.github.io'];
const FACT_FIELDS = 'id,name,length_2d,duration,ascent,departure,departure_geom,route';
const CACHE_SECONDS = 86400;
const ALLOWED_PARAMS = /^(in_bbox|practices)$/;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    if (!ALLOWED_ORIGINS.includes(origin)) return new Response('Origine non autorisée', { status: 403 });
    const cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
    if (request.method === 'OPTIONS') return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET' } });
    if (request.method !== 'GET') return new Response('Méthode non autorisée', { status: 405, headers: cors });

    const url = new URL(request.url);
    const api = SOURCES[url.pathname.slice(1)];
    if (!api) return new Response('Source inconnue', { status: 404, headers: cors });

    const target = new URL(`${api}/trek/`);
    target.search = new URLSearchParams({ format: 'json', language: 'fr', page_size: '100', fields: FACT_FIELDS });
    for (const [name, value] of url.searchParams) {
      if (ALLOWED_PARAMS.test(name)) target.searchParams.set(name, value);
    }

    const cacheKey = new Request(target.toString());
    const cached = await caches.default.match(cacheKey);
    if (cached) return withCors(cached, cors);

    const upstream = await fetch(target, { headers: { 'User-Agent': 'Wikitel/0.1 (relais)', Accept: 'application/json' } });
    if (!upstream.ok) return new Response('Source indisponible', { status: 502, headers: cors });
    const stored = new Response(upstream.body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_SECONDS}` } });
    ctx.waitUntil(caches.default.put(cacheKey, stored.clone()));
    return withCors(stored, cors);
  },
};

function withCors(response, cors) {
  const copy = new Response(response.body, response);
  for (const [name, value] of Object.entries(cors)) copy.headers.set(name, value);
  return copy;
}
