#!/usr/bin/env python3
"""Génère data/geotrek-sources.json : sources Geotrek utilisables, avec leur emprise.

Ne recopie aucune fiche : seulement l'emprise géographique et les identifiants de pratiques.
EXCLUDED liste les sources dont les mentions légales interdisent la reproduction sans
autorisation (relevé du 2026-11-07, à refaire avant d'ajouter une source).
"""
import json, re, sys, time, urllib.request
from pathlib import Path

UA = "Wikitel/0.1 (build tool)"
SOURCES = json.load(open(sys.argv[1]))  # sortie de la découverte : name, site, api, cors, count
EXCLUDED = {
    "Fédération Française de Cyclisme (FFC)": "vélo uniquement",
    "LPO Biodiv'Sports": "aucune randonnée",
    "Espace Nordique Jurassien": "ski nordique",
    "Via Columbani": "reproduction interdite",
    "Conseil départemental de Haute-Loire (CD43)": "reproduction soumise à autorisation",
    "Conseil départemental du Jura (CD39)": "reproduction interdite",
    "Parc National des Écrins": "droits de reproduction réservés",
    "Parc Naturel Régional des Alpilles": "droits de reproduction réservés",
    "Conseil départemental du Doubs (CD25)": "reproduction soumise à autorisation",
    "Parc Naturel Régional de Mille vaches en Limousin": "droits de reproduction réservés",
    "Parc Naturel Régional du Livradois-Forez": "reproduction interdite",
    "Conseil départemental de l’Orne (CD61)": "reproduction interdite",
    "Parc Naturel Régional de Loire-Anjou-Touraine": "droits de reproduction réservés",
    "Parc Naturel Régional du Vexin français": "droits de reproduction réservés",
    "Communauté de Communes du Sisteronais-Buëch": "droits réservés",
    "Conseil départemental du Pas-de-Calais (CD62)": "usage restreint",
    "Communauté de communes d'Ardèche en Hermitage": "reproduction interdite",
    "Communauté de Communes Alès Agglomération": "reproduction interdite",
    "Conseil départemental des Pyrénées-Orientales (CD66)": "reproduction restreinte",
    "Communauté de communes des Pyrénées Haut-Garonnaises": "reproduction interdite",
    "Parc Naturel Régional des Vosges du Nord": "reproduction interdite",
    "Conservatoire d’Espaces Naturels de Haute-Savoie": "droits de reproduction réservés",
    "Parc National de la Réunion": "contenu protégé",
    "Office de tourisme du Grand Carcassonne": "droits de reproduction réservés",
}
WALKING = re.compile(r"p[ée]destre|\bpied\b|randonn[ée]e|marche", re.I)
NOT_WALKING = re.compile(r"raquette|cheval|[ée]questre|ski|v[ée]lo|vtt", re.I)
LOOP = re.compile(r"boucle", re.I)


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=40) as res:
        return json.load(res)


def label(value):
    return value.get("fr") if isinstance(value, dict) else value


def ids(api, resource, pattern):
    data = get(f"{api}/{resource}/?format=json&page_size=100&language=fr")
    names = [(r["id"], label(r.get("name") or r.get("route") or "") or "") for r in data["results"]]
    return [i for i, name in names if pattern.search(name) and not NOT_WALKING.search(name)]


def bbox(api, practices):
    lons, lats = [], []
    url = f"{api}/trek/?format=json&page_size=200&fields=departure_geom&practices={','.join(map(str, practices))}"
    while url:
        data = get(url)
        for trek in data["results"]:
            geom = trek.get("departure_geom")
            if geom:
                lons.append(geom[0])
                lats.append(geom[1])
        url = data.get("next")
        time.sleep(0.5)
    return [round(min(lons), 3), round(min(lats), 3), round(max(lons), 3), round(max(lats), 3)], len(lons) if lons else (None, 0)


out = []
for source in SOURCES:
    if source["name"] in EXCLUDED or not source.get("api"):
        continue
    api = source["api"]
    try:
        practices = ids(api, "trek_practice", WALKING)
        if not practices:
            print("sans pratique pédestre :", source["name"], file=sys.stderr)
            continue
        box, count = bbox(api, practices)
        loops = ids(api, "trek_route", LOOP)
    except Exception as err:
        print("échec :", source["name"], err, file=sys.stderr)
        continue
    key = re.sub(r"[^a-z0-9]+", "-", api.split("//")[1].split("/")[0].lower()).strip("-")
    out.append({
        "key": key, "name": source["name"], "site": source["site"], "api": api,
        "direct": bool(source.get("cors")), "bbox": box, "count": count,
        "practices": practices, "loops": loops,
    })
    print(f"{source['name'][:45]:45} {count:5} {box} direct={bool(source.get('cors'))}", file=sys.stderr)
    time.sleep(1)

root = Path(__file__).resolve().parent.parent
(root / "data" / "geotrek-sources.json").write_text(json.dumps({"sources": out}, ensure_ascii=False, indent=1))

# Le relais n'accepte que les sources inaccessibles directement depuis un navigateur.
relayed = {s["key"]: s["api"] for s in out if not s["direct"]}
template = (root / "tools" / "relay_template.js").read_text()
(root / "relay" / "worker.js").write_text(template.replace("/*SOURCES*/{}", json.dumps(relayed, indent=2)))
print(len(out), "sources", file=sys.stderr)
