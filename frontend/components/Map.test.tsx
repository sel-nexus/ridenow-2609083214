// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Map from './Map';

const leaflet = vi.hoisted(() => {
  type Callback = (event: any) => void;
  const state: { mapEvents: Record<string, Callback>; markerEvents: Record<string, Callback>; tileEvents: Record<string, Callback>; markers: any[] } = {mapEvents: {}, markerEvents: {}, tileEvents: {}, markers: []};
  const instance = {setView: vi.fn().mockReturnThis(), on: vi.fn((name: string, fn: Callback) => {state.mapEvents[name] = fn;}), once: vi.fn((name: string, fn: Callback) => {state.mapEvents[name] = fn;}), remove: vi.fn(() => state.mapEvents.unload?.({}))};
  const tiles = {addTo: vi.fn().mockReturnThis(), on: vi.fn((name: string, fn: Callback) => {state.tileEvents[name] = fn;}), setUrl: vi.fn()};
  return {state, instance, tiles, map: vi.fn(() => instance), tileLayer: vi.fn((_url: string) => tiles), divIcon: vi.fn((options: unknown) => options), marker: vi.fn(() => {
    const element = document.createElement('div');
    element.tabIndex = 0;
    const marker = {addTo: vi.fn().mockReturnThis(), getElement: vi.fn(() => element), setLatLng: vi.fn(), getLatLng: vi.fn(() => ({lat: 17.6, lng: 78.2})), on: vi.fn((name: string, fn: Callback) => {state.markerEvents[name] = fn;})};
    state.markers.push(marker); return marker;
  })};
});
vi.mock('leaflet', () => leaflet);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('React', React);
  leaflet.state.mapEvents = {}; leaflet.state.markerEvents = {}; leaflet.state.tileEvents = {}; leaflet.state.markers = [];
  document.documentElement.dataset.theme = 'light';
  vi.stubGlobal('matchMedia', vi.fn(() => ({matches: true})));
});
afterEach(() => {cleanup(); vi.unstubAllGlobals(); delete document.documentElement.dataset.theme;});

it('selects and clamps map clicks and dragged pins, using the latest callback', async () => {
  const first = vi.fn(); const selected = vi.fn();
  const view = render(<Map location={null} onSelect={first} />);
  expect(screen.getByLabelText('Interactive Hyderabad map')).toBeInTheDocument();
  await waitFor(() => expect(leaflet.state.markers).toHaveLength(8));
  view.rerender(<Map location={null} onSelect={selected} />);
  act(() => leaflet.state.mapEvents.click({latlng: {lat: 17.42, lng: 78.4}}));
  expect(selected).toHaveBeenCalledWith({name: 'Map pin (17.42000, 78.40000)', lat: 17.42, lng: 78.4});
  act(() => leaflet.state.markerEvents.dragend({}));
  expect(selected).toHaveBeenLastCalledWith({name: 'Map pin (17.55000, 78.30000)', lat: 17.55, lng: 78.3});
  expect(leaflet.state.markers[1].setLatLng).toHaveBeenLastCalledWith([17.55, 78.3]);
  expect(first).not.toHaveBeenCalled();
});

it('allows a keyboard user to move the destination pin and clamps it to the service area', async () => {
  const selected = vi.fn();
  const user = userEvent.setup();
  render(<Map location={null} onSelect={selected} />);
  await waitFor(() => expect(leaflet.state.markers).toHaveLength(8));
  const marker = leaflet.state.markers[1];
  const element = marker.getElement();
  document.body.appendChild(element);
  expect(element).toHaveAttribute('aria-label', expect.stringContaining('arrow keys'));
  element.focus();
  await user.keyboard('{ArrowRight}');
  expect(selected).toHaveBeenCalledWith({name: 'Map pin (17.55000, 78.30000)', lat: 17.55, lng: 78.3});
  selected.mockClear();
  await user.keyboard('a');
  await user.keyboard('{Control>}{ArrowLeft}{/Control}');
  expect(selected).not.toHaveBeenCalled();
  element.remove();
});

it('updates the marker and view when an external location changes', async () => {
  const initial = {name: 'First', lat: 17.4, lng: 78.4};
  const view = render(<Map location={initial} onSelect={() => {}} />);
  await waitFor(() => expect(leaflet.state.markers).toHaveLength(8));
  expect(leaflet.state.markers[1].setLatLng).toHaveBeenCalledWith([17.4, 78.4]);
  expect(leaflet.instance.setView).toHaveBeenCalledWith([17.4, 78.4], 14);
  view.rerender(<Map location={{name: 'Second', lat: 17.3, lng: 78.5}} onSelect={() => {}} />);
  expect(leaflet.state.markers[1].setLatLng).toHaveBeenLastCalledWith([17.3, 78.5]);
  expect(leaflet.instance.setView).toHaveBeenLastCalledWith([17.3, 78.5], 14);
});

it('switches tiles with theme, reports repeated tile failures and removes listeners', async () => {
  document.documentElement.dataset.theme = 'dark';
  const view = render(<Map location={null} onSelect={() => {}} />);
  await waitFor(() => expect(leaflet.tileLayer).toHaveBeenCalled());
  expect(leaflet.tileLayer.mock.calls[0][0]).toContain('dark_all');
  document.documentElement.dataset.theme = 'light';
  act(() => window.dispatchEvent(new Event('ridenow-resolved-theme')));
  expect(leaflet.tiles.setUrl).toHaveBeenCalledWith(expect.stringContaining('openstreetmap'));
  act(() => {leaflet.state.tileEvents.tileerror({}); leaflet.state.tileEvents.tileerror({});});
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  act(() => leaflet.state.tileEvents.tileerror({}));
  expect(screen.getByRole('alert')).toHaveTextContent('Map tiles could not load');
  view.unmount();
  expect(leaflet.instance.remove).toHaveBeenCalled();
  leaflet.tiles.setUrl.mockClear();
  window.dispatchEvent(new Event('ridenow-resolved-theme'));
  expect(leaflet.tiles.setUrl).not.toHaveBeenCalled();
});
