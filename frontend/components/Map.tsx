'use client';

import { useEffect, useRef, useState } from 'react';
import type { Location } from '../lib/api';
import type * as Leaflet from 'leaflet';

const bounds: [[number, number], [number, number]] = [[17.2, 78.3], [17.55, 78.7]];
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Render a draggable destination pin over an interactive Hyderabad map. */
export default function Map({ location, onSelect }: { location: Location | null; onSelect: (location: Location) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const pin = useRef<Leaflet.Marker | null>(null);
  const handler = useRef(onSelect);
  const selected = useRef(location);
  const [error, setError] = useState('');
  handler.current = onSelect;
  selected.current = location;

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    void import('leaflet').then(L => {
      if (disposed || !container.current) return;
      const instance = L.map(container.current, { maxBounds: bounds, maxBoundsViscosity: 1 }).setView([17.4435, 78.3772], 13);
      map.current = instance;
      const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const tiles = L.tileLayer(dark ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png' : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: dark ? '&copy; OpenStreetMap contributors &copy; CARTO' : '&copy; OpenStreetMap contributors', maxZoom: 19
      }).addTo(instance);
      let tileFailures = 0;
      tiles.on('tileerror', () => { if (++tileFailures >= 3) setError('Map tiles could not load. Search and coordinates are still available.'); });
      const pickup = L.divIcon({className: 'pickup-icon', html: '<span></span>', iconSize: [24, 24]});
      L.marker([17.4435, 78.3772], {icon: pickup, interactive: false}).addTo(instance);
      const destination = L.divIcon({className: 'destination-icon', html: '<span></span>', iconSize: [24, 24], iconAnchor: [12, 24]});
      const marker = L.marker([17.4435, 78.3772], {icon: destination, draggable: true, title: 'Drag destination pin', keyboard: true}).addTo(instance);
      pin.current = marker;
      if (selected.current) { marker.setLatLng([selected.current.lat, selected.current.lng]); instance.setView([selected.current.lat, selected.current.lng], 14); }
      const selectPoint = (lat: number, lng: number) => {
        const point = {lat: clamp(lat, 17.2, 17.55), lng: clamp(lng, 78.3, 78.7)};
        marker.setLatLng([point.lat, point.lng]);
        handler.current({name: `Map pin (${point.lat.toFixed(5)}, ${point.lng.toFixed(5)})`, ...point});
      };
      marker.on('dragend', () => { const point = marker.getLatLng(); selectPoint(point.lat, point.lng); });
      instance.on('click', event => selectPoint(event.latlng.lat, event.latlng.lng));
      const car = L.divIcon({className: 'vehicle-icon', html: '<span>◆</span>', iconSize: [20, 20]});
      const vehicles = Array.from({length: 6}, (_, i) => {
        const lat = 17.4435 + (Math.random() - .5) * .022;
        const lng = 78.3772 + (Math.random() - .5) * .025;
        return {lat, lng, phase: i, marker: L.marker([lat, lng], {icon: car, interactive: false}).addTo(instance)};
      });
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) timer = window.setInterval(() => {
        vehicles.forEach(vehicle => { vehicle.phase += .18; vehicle.marker.setLatLng([vehicle.lat + Math.sin(vehicle.phase) * .0005, vehicle.lng + Math.cos(vehicle.phase) * .0006]); });
      }, 1500);
    }).catch(() => setError('The map could not load. Search is still available.'));
    return () => { disposed = true; if (timer) window.clearInterval(timer); map.current?.remove(); map.current = null; pin.current = null; };
  }, []);
  useEffect(() => { if (location && pin.current && map.current) { pin.current.setLatLng([location.lat, location.lng]); map.current.setView([location.lat, location.lng], 14); } }, [location]);
  return <div className="map-wrap"><div ref={container} className="map-canvas" aria-label="Interactive Hyderabad map" />{error && <p className="map-error" role="alert">{error}</p>}</div>;
}
