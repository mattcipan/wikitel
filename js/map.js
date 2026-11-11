// Carte : Leaflet, chargé seulement à l'ouverture de la carte, et fonds de carte OpenStreetMap.
import { distanceKm } from './places.js';

let leaflet;
export function loadLeaflet() {
  leaflet ??= new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'vendor/leaflet/leaflet.css';
    document.head.append(css);
    const script = document.createElement('script');
    script.src = 'vendor/leaflet/leaflet.js';
    script.onload = () => resolve(window.L);
    script.onerror = () => { leaflet = null; css.remove(); script.remove(); reject(new Error('Leaflet indisponible')); };
    document.head.append(script);
  });
  return leaflet;
}

export const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

// Zoom de départ selon le rayon de recherche, pour voir tout le périmètre.
export function zoomForRadius(km) {
  if (km <= 1) return 15;
  if (km <= 2) return 14;
  if (km <= 5) return 13;
  if (km <= 10) return 12;
  return 10;
}

export function pathKm(points) {
  return points.slice(1).reduce((sum, point, index) => sum + distanceKm(points[index], point), 0);
}

// Ordre de visite le plus court depuis `start` : plus proche voisin, puis amélioration 2-opt.
// Les étapes sont peu nombreuses, le calcul est instantané.
export function shortestOrder(start, stops) {
  const rest = [...stops];
  const path = [start];
  while (rest.length) {
    const last = path[path.length - 1];
    let best = 0;
    rest.forEach((stop, index) => { if (distanceKm(last, stop) < distanceKm(last, rest[best])) best = index; });
    path.push(rest.splice(best, 1)[0]);
  }
  for (let improved = true; improved;) {
    improved = false;
    for (let i = 1; i < path.length - 1; i++) {
      for (let k = i + 1; k < path.length; k++) {
        const [a, b, c, d] = [path[i - 1], path[i], path[k], path[k + 1]];
        const before = distanceKm(a, b) + (d ? distanceKm(c, d) : 0);
        const after = distanceKm(a, c) + (d ? distanceKm(b, d) : 0);
        if (after < before - 1e-9) {
          path.splice(i, k - i + 1, ...path.slice(i, k + 1).reverse());
          improved = true;
        }
      }
    }
  }
  return path.slice(1);
}

// Google Maps accepte au plus 9 étapes intermédiaires. Sans départ indiqué, il part de la position du téléphone.
export const MAX_ROUTE_STOPS = 10;
export function googleRouteUrl(stops, mode, origin) {
  const point = (p) => `${p.lat},${p.lon}`;
  const kept = stops.slice(0, origin ? MAX_ROUTE_STOPS + 1 : MAX_ROUTE_STOPS);
  const params = new URLSearchParams({ api: '1', destination: point(kept[kept.length - 1]), travelmode: mode });
  if (origin) params.set('origin', point(origin));
  const between = kept.slice(0, -1);
  if (between.length) params.set('waypoints', between.map(point).join('|'));
  return `https://www.google.com/maps/dir/?${params}`;
}
