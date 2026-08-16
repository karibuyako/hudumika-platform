/* M11 — Maps abstraction (blueprint §26 "Maps abstraction"): the pure,
 * dependency-free seam that renders live tracking + address pins without a
 * native maps SDK. All helpers here are Node-safe (no react-native, no maps
 * package) so the tests assert the projection and marker math directly.
 *
 * The component shell (src/components/MapView.tsx) renders exactly these
 * numbers: markerX/markerY are px anchors on the surface, accuracyRadius is
 * the disc size, and the surface size comes from the same defaults. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCURACY_MIN_PX,
  coordinateLabel,
  deriveZoom,
  mapProps,
  MAP_DEFAULT_HEIGHT,
  MAP_DEFAULT_WIDTH,
  MAP_MAX_ZOOM_PX_PER_KM,
  MAP_MIN_ZOOM_PX_PER_KM,
  projectTo2D,
  renderMapSurface,
  toCoordinate,
  type Coordinate,
} from '@/lib/maps';

const CENTER: Coordinate = { lat: -6.7924, lon: 39.2083 };
const KM_PER_DEG = 111.32;

test('projectTo2D maps the center to the origin at any zoom', () => {
  for (const zoom of [24, 80, 320]) {
    const [x, y] = projectTo2D(CENTER, CENTER, zoom);
    assert.deepEqual([x, y], [0, 0], `center must be the origin at zoom ${zoom}`);
  }
});

test('projectTo2D is monotonic with distance and symmetric about the center', () => {
  const zoom = 80;
  const north = projectTo2D({ lat: CENTER.lat + 0.1, lon: CENTER.lon }, CENTER, zoom);
  const south = projectTo2D({ lat: CENTER.lat - 0.1, lon: CENTER.lon }, CENTER, zoom);
  const east = projectTo2D({ lat: CENTER.lat, lon: CENTER.lon + 0.1 }, CENTER, zoom);
  const west = projectTo2D({ lat: CENTER.lat, lon: CENTER.lon - 0.1 }, CENTER, zoom);

  // 0.1° latitude ≈ 11.1 km → 890 px at 80 px/km. Screen y grows DOWN: a
  // point north of the center projects negative (up), south positive.
  const expected = 0.1 * KM_PER_DEG * zoom;
  assert.ok(Math.abs(north[1] + expected) < 1, `north ≈ −${expected} px, got ${north[1]}`);
  assert.ok(Math.abs(south[1] - expected) < 1, 'south is symmetric');
  assert.ok(Math.abs(east[0] - expected * Math.cos((CENTER.lat * Math.PI) / 180)) < 1, 'east follows the lon cosine scaling');
  // Lon offset is mirrored about the center: west projects negative x.
  assert.ok(Math.abs(west[0] + east[0]) < 1, 'west is symmetric');

  // Monotonic: a farther point projects farther away.
  const farther = projectTo2D({ lat: CENTER.lat + 0.2, lon: CENTER.lon }, CENTER, zoom);
  assert.ok(Math.abs(farther[1]) > Math.abs(north[1]), 'distance monotonic');
});

test('deriveZoom fits the accuracy: larger accuracy → smaller scale, clamped', () => {
  assert.equal(deriveZoom(undefined), 80, 'default when no accuracy');
  assert.equal(deriveZoom(1), 80, '1 km accuracy keeps the default scale');
  assert.ok(deriveZoom(0.25) > deriveZoom(2), 'tighter accuracy zooms in');
  assert.equal(deriveZoom(0.0001), MAP_MAX_ZOOM_PX_PER_KM, 'clamped to max zoom');
  assert.equal(deriveZoom(1000), MAP_MIN_ZOOM_PX_PER_KM, 'clamped to min zoom');
});

test('renderMapSurface returns a marker within the surface for a nearby coordinate', () => {
  const surface = renderMapSurface({ center: CENTER, marker: { lat: CENTER.lat + 0.004, lon: CENTER.lon - 0.003 } });
  assert.equal(surface.markers.length, 1);
  const m = surface.markers[0];
  assert.equal(m.visible, true, 'a ~0.5 km offset fits a default surface');
  assert.ok(m.x >= 0 && m.x <= MAP_DEFAULT_WIDTH, `x inside bounds (${m.x})`);
  assert.ok(m.y >= 0 && m.y <= MAP_DEFAULT_HEIGHT, `y inside bounds (${m.y})`);
  // A marker at the center lands exactly mid-surface.
  const centered = renderMapSurface({ center: CENTER, marker: CENTER }).markers[0];
  assert.equal(centered.x, MAP_DEFAULT_WIDTH / 2);
  assert.equal(centered.y, MAP_DEFAULT_HEIGHT / 2);
});

test('renderMapSurface returns no markers when the marker is null', () => {
  assert.deepEqual(renderMapSurface({ center: CENTER, marker: null }).markers, []);
  assert.deepEqual(renderMapSurface({ center: CENTER }).markers, [], 'omitted marker behaves like null');
});

test('renderMapSurface flags an off-surface marker as invisible (no clamp)', () => {
  const far = renderMapSurface({ center: CENTER, marker: { lat: CENTER.lat + 5, lon: CENTER.lon + 5 } });
  assert.equal(far.markers.length, 1);
  assert.equal(far.markers[0].visible, false, 'a 5° offset is way outside the surface');
});

test('coordinateLabel formats as "lat, lon" with 5 decimals', () => {
  assert.equal(coordinateLabel(CENTER), '-6.79240, 39.20830');
  assert.equal(coordinateLabel({ lat: 0, lon: 0 }), '0.00000, 0.00000');
  assert.match(coordinateLabel({ lat: -6.7924, lon: 39.2083 }), /^-?\d+\.\d{5}, -?\d+\.\d{5}$/);
});

test('mapProps: centered marker sits mid-surface, accuracy disc scales from the accuracy', () => {
  const props = mapProps(CENTER, CENTER, 0.5);
  assert.equal(props.hasMarker, true);
  assert.equal(props.markerX, MAP_DEFAULT_WIDTH / 2, 'marker is the center');
  assert.equal(props.markerY, MAP_DEFAULT_HEIGHT / 2);
  // 0.5 km at the derived zoom (80/0.5=160 px/km, below the 320 cap) → 80 px.
  assert.equal(props.accuracyRadius, 80);
  assert.equal(props.zoomPxPerKm, 160);
});

test('mapProps: no marker → hasMarker false, no accuracy disc', () => {
  const props = mapProps(CENTER, null, 0.5);
  assert.equal(props.hasMarker, false);
  assert.equal(props.accuracyRadius, 0);
});

test('mapProps: accuracy disc is clamped to a minimum and to the surface', () => {
  const tiny = mapProps(CENTER, CENTER, 0.0001);
  assert.equal(tiny.accuracyRadius, ACCURACY_MIN_PX, 'exact fix still shows a disc');
  const huge = mapProps(CENTER, CENTER, 1000);
  assert.ok(huge.accuracyRadius < Math.min(MAP_DEFAULT_WIDTH, MAP_DEFAULT_HEIGHT) / 2, 'disc never overflows the surface');
});

test('mapProps: a marker offset from the center projects onto the surface', () => {
  const east = mapProps(CENTER, { lat: CENTER.lat, lon: CENTER.lon + 0.01 }, 0.5);
  assert.ok(east.markerX > MAP_DEFAULT_WIDTH / 2, 'east of center lands right of center');
  const north = mapProps(CENTER, { lat: CENTER.lat + 0.01, lon: CENTER.lon }, 0.5);
  assert.ok(north.markerY < MAP_DEFAULT_HEIGHT / 2, 'north of center lands above center');
});

test('toCoordinate accepts only complete, finite coordinates', () => {
  assert.deepEqual(toCoordinate({ lat: -6.79, lon: 39.2 }), { lat: -6.79, lon: 39.2 });
  assert.equal(toCoordinate({ lat: -6.79 }), null, 'missing lon rejected');
  assert.equal(toCoordinate({}), null);
  assert.equal(toCoordinate(null), null);
  assert.equal(toCoordinate(undefined), null);
  assert.equal(toCoordinate({ lat: Number.NaN, lon: 39.2 }), null, 'NaN rejected');
});
