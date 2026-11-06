#!/usr/bin/env python3
"""Génère data/types.json : pour chaque type Wikidata (P31 / P106), les drapeaux Wikitel.

À relancer ponctuellement (pas à chaque build). L'appli n'interroge jamais SPARQL :
le service de requêtes Wikidata est trop limité pour être appelé au runtime.
"""
import csv, io, json, sys, time, urllib.parse, urllib.request
from pathlib import Path

HISTOIRE, CULTURE, ARCHITECTURE, SETTLEMENT, ARTIST = 1, 2, 4, 8, 16

ROOTS = {
    "histoire": ["Q839954", "Q57821", "Q5003624", "Q109607", "Q39614", "Q820477", "Q178561",
                 "Q1081138", "Q44613", "Q4989906", "Q23413"],
    "culture": ["Q33506", "Q24354", "Q1060829", "Q41253", "Q7075", "Q132241", "Q219423", "Q570116",
                "Q153562", "Q3152824"],
    "architecture": ["Q16970", "Q12518", "Q12280", "Q16560", "Q23413", "Q483110", "Q1370598",
                     "Q24354", "Q4989906", "Q1076486", "Q174782"],
    # Ne servent qu'à retirer ces types de la catégorie générique « bâtiment ».
    "exclude": ["Q56061", "Q34442", "Q55488", "Q3914", "Q4830453", "Q1248784", "Q3947"],
    "generic": ["Q41176"],
    "settlement": ["Q486972", "Q15284", "Q515", "Q3957", "Q532"],
    "artist": ["Q483501"],
}


def closure(root):
    query = f"SELECT DISTINCT ?t WHERE {{ ?t wdt:P279* wd:{root} }}"
    url = "https://query.wikidata.org/sparql?" + urllib.parse.urlencode({"query": query})
    req = urllib.request.Request(url, headers={"Accept": "text/csv", "User-Agent": "Wikitel/0.1 (build tool)"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=70) as res:
                rows = list(csv.reader(io.StringIO(res.read().decode())))[1:]
            return {r[0].rsplit("/", 1)[-1] for r in rows if r and "/Q" in r[0]}
        except Exception as err:
            print(f"  {root}: {err}, nouvel essai", file=sys.stderr)
            time.sleep(20 * (attempt + 1))
    raise SystemExit(f"Échec pour {root}")


cache = {}
sets = {}
for name, roots in ROOTS.items():
    sets[name] = set()
    for root in roots:
        if root not in cache:
            cache[root] = closure(root)
            print(f"{name:13}{root:11}{len(cache[root])}", file=sys.stderr)
            time.sleep(2)
        sets[name] |= cache[root]

# La sculpture a trop de sous-classes (œuvres individuelles) pour une fermeture complète.
sets["culture"] |= {"Q860861", "Q179700", "Q241045"}

flags = {}
for qid in set().union(*sets.values()):
    value = 0
    if qid in sets["histoire"]: value |= HISTOIRE
    if qid in sets["culture"]: value |= CULTURE
    if qid in sets["architecture"]: value |= ARCHITECTURE
    if not value and qid in sets["generic"] and qid not in sets["exclude"]: value |= ARCHITECTURE
    if qid in sets["settlement"]: value |= SETTLEMENT
    if qid in sets["artist"]: value |= ARTIST
    if value: flags[qid] = value

# Regroupé par drapeau et sans le « Q », pour un fichier compact.
grouped = {}
for qid, value in flags.items():
    grouped.setdefault(str(value), []).append(int(qid[1:]))
out = Path(__file__).resolve().parent.parent / "data" / "types.json"
out.write_text(json.dumps({k: sorted(v) for k, v in grouped.items()}, separators=(",", ":")))
print(f"{len(flags)} types, {out.stat().st_size // 1024} Ko", file=sys.stderr)
