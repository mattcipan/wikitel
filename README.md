# Wikitel

Les lieux et les personnalités autour de vous, racontés par Wikipédia. Application web statique (PWA), sans dépendance ni étape de build.

## Lancer en local

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

Puis ouvrir http://localhost:8765.

## Déployer

Publier le dossier tel quel sur un hébergement statique en HTTPS : la géolocalisation et l'installation sur téléphone l'exigent.

À chaque publication, changer le numéro dans `version.json` : c'est lui qui déclenche le rechargement de l'appli sur les téléphones déjà ouverts, et il s'affiche dans les réglages.

## Organisation

- `js/places.js` : recherche, classement par thème et tri des lieux et des personnes
- `js/hikes.js` : randonnées depuis les sites Geotrek (faits seulement), avec OpenStreetMap en complément
- `data/geotrek-sources.json` et `relay/worker.js` : générés par `tools/build_geotrek_sources.py`, qui liste aussi les sources écartées pour raisons légales
- `js/article.js` : récupération, nettoyage et mise en forme des articles
- `js/speech.js` : écoute des articles (synthèse vocale du navigateur)
- `js/store.js` : historique, favoris et réglages, sur l'appareil
- `data/types.json` : table des types Wikidata, régénérée par `tools/build_types.py`

Le classement utilise `data/types.json` plutôt que le service SPARQL de Wikidata, trop limité pour être appelé depuis l'appli. Pour changer ce qui entre dans un thème, modifier `ROOTS` dans `tools/build_types.py`, puis relancer le script.

## Licences

Textes de Wikipédia sous CC BY-SA 4.0, avec attribution affichée sous chaque article. Randonnées © contributeurs OpenStreetMap, licence ODbL, avec attribution affichée. Les données Geotrek restent la propriété de leurs structures : l'appli n'en stocke aucune copie publique et renvoie vers leurs fiches. Police VT323 sous SIL OFL (`assets/OFL-vt323.txt`).
