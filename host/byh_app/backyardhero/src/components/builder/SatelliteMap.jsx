import React, { useEffect, useMemo, useRef } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Circle,
  Polyline,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Real-world satellite map for show layout. Uses Esri's "World_Imagery"
// tile service (free, no API key, no auth) layered with the OSM
// "Reference" overlay for road / place labels. Geocoding is done via
// the OpenStreetMap Nominatim service (also free) -- see AddressSearch.
//
// This file is intentionally pure react-leaflet + leaflet. It pulls
// `window`/`document` at import time, so callers MUST load it via
// next/dynamic with `ssr: false` (see SpatialLayoutMap).

const ESRI_WORLD_IMAGERY =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const ESRI_ATTRIBUTION =
  'Tiles © <a href="https://www.esri.com/">Esri</a> — Source: Esri, Maxar, Earthstar Geographics, USGS, GIS Community';

// Re-center the map declaratively when the `center` / `zoom` props
// change (e.g. operator picks a new address from the search dropdown).
// react-leaflet only feeds initial center to MapContainer; subsequent
// view changes have to go through the imperative L.Map handle.
function MapView({ center, zoom }) {
  const map = useMap();
  const lat = center?.lat;
  const lng = center?.lng;
  useEffect(() => {
    if (lat == null || lng == null) return;
    const target = [lat, lng];
    const targetZoom = zoom ?? map.getZoom();
    const cur = map.getCenter();
    // Avoid yanking the map if the operator just dragged a marker --
    // only re-center if the requested center is actually different.
    if (
      Math.abs(cur.lat - lat) > 1e-6 ||
      Math.abs(cur.lng - lng) > 1e-6 ||
      Math.abs(map.getZoom() - targetZoom) > 0.01
    ) {
      map.setView(target, targetZoom, { animate: true });
    }
  }, [map, lat, lng, zoom]);
  return null;
}

// Surface map-level ready / move events to the parent (used to record
// the operator's pan/zoom into `_meta` so the saved layout reopens to
// the same view).
function MapEvents({ onMoveEnd }) {
  const map = useMap();
  useEffect(() => {
    if (!onMoveEnd) return;
    const fn = () => {
      const c = map.getCenter();
      onMoveEnd({ lat: c.lat, lng: c.lng, zoom: map.getZoom() });
    };
    map.on("moveend", fn);
    return () => map.off("moveend", fn);
  }, [map, onMoveEnd]);
  return null;
}

// Internal: surface current zoom to siblings via a setter callback so
// the safety-ring layer can self-hide at zooms where the rings would be
// tiny illegible smears. Cheaper than re-rendering MapContainer for
// every zoom step.
function ZoomTracker({ onZoom }) {
  const map = useMap();
  useEffect(() => {
    if (!onZoom) return;
    onZoom(map.getZoom());
    const fn = () => onZoom(map.getZoom());
    map.on("zoomend", fn);
    return () => map.off("zoomend", fn);
  }, [map, onZoom]);
  return null;
}

// Hand the live L.Map instance back up to the parent so it can run
// imperative actions ("center zones in window", "fit to markers", ...).
// We can't lift this through MapContainer's ref alone because under
// dynamic + react-leaflet 5 that ref isn't reliably populated until
// after a render tick; this child component runs in the same render
// pass that mounts the map.
function MapReadyHandshake({ onReady }) {
  const map = useMap();
  useEffect(() => {
    if (!onReady) return;
    onReady(map);
    return () => onReady(null);
  }, [map, onReady]);
  return null;
}

// Receiver pin: small blue dot with the receiver short name underneath
// and a red badge for the assigned-item count. Built as a divIcon so
// we can style it with the app's existing tailwind tokens instead of
// shipping bitmap icons through webpack (also dodges leaflet's
// well-known "default marker icon 404 in webpack" issue).
function makeReceiverIcon({ label, badge }) {
  const labelHtml = label
    ? `<span class="byh-pin__label">${escapeHtml(String(label))}</span>`
    : "";
  const badgeHtml =
    badge != null && badge !== ""
      ? `<span class="byh-pin__badge">${escapeHtml(String(badge))}</span>`
      : "";
  return L.divIcon({
    className: "byh-pin",
    html: `<div class="byh-pin__dot">${badgeHtml}</div>${labelHtml}`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

// Tiny non-interactive label icon used for safety-ring radius callouts.
// `interactive: false` on the Marker keeps it from intercepting drag
// events on the underlying receiver pin.
function makeRingLabelIcon(text) {
  return L.divIcon({
    className: "byh-ring-label",
    html: `<span class="byh-ring-label__text">${escapeHtml(String(text))}</span>`,
    iconSize: [44, 16],
    iconAnchor: [22, 8],
  });
}

// Non-interactive midpoint label for the pairwise-distance highlight
// line (see DistanceHighlight below). Sized larger than the ring label
// because it's the "active measurement" the operator is reading.
function makeDistanceLabelIcon(text) {
  return L.divIcon({
    className: "byh-distance-label",
    html: `<span class="byh-distance-label__text">${escapeHtml(String(text))}</span>`,
    iconSize: [80, 20],
    iconAnchor: [40, 10],
  });
}

// Hover-driven visualization of a single pairwise distance between two
// receivers. Renders a yellow line (with a black halo for contrast over
// bright satellite imagery) and a midpoint label with the distance text.
// Non-interactive so it doesn't intercept drags on the markers beneath.
function DistanceHighlight({ a, b, label }) {
  if (
    !a || !b ||
    !Number.isFinite(a.lat) || !Number.isFinite(a.lng) ||
    !Number.isFinite(b.lat) || !Number.isFinite(b.lng)
  ) {
    return null;
  }
  const positions = [[a.lat, a.lng], [b.lat, b.lng]];
  // Midpoint via simple lat/lng average. At backyard scales (well under
  // a kilometre) the great-circle midpoint differs from this by sub-foot
  // amounts -- not worth the math.
  const midLat = (a.lat + b.lat) / 2;
  const midLng = (a.lng + b.lng) / 2;
  return (
    <>
      {/* Black halo for contrast against bright (snow, sand, concrete)
          satellite imagery. */}
      <Polyline
        positions={positions}
        pathOptions={{
          color: "#000000",
          weight: 6,
          opacity: 0.4,
          interactive: false,
        }}
      />
      <Polyline
        positions={positions}
        pathOptions={{
          color: "#facc15", // yellow-400 -- matches the .__text colour
          weight: 2.5,
          opacity: 1,
          interactive: false,
        }}
      />
      {label ? (
        <Marker
          position={[midLat, midLng]}
          icon={makeDistanceLabelIcon(label)}
          interactive={false}
          keyboard={false}
        />
      ) : null}
    </>
  );
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// Single draggable receiver marker. Memoised on label/badge/draggable
// so updating other markers doesn't recreate this one's leaflet handle.
function ReceiverMarker({
  receiverKey,
  position,
  label,
  badge,
  draggable,
  onDragEnd,
}) {
  const ref = useRef(null);
  const icon = useMemo(
    () => makeReceiverIcon({ label, badge }),
    [label, badge]
  );

  return (
    <Marker
      ref={ref}
      position={[position.lat, position.lng]}
      icon={icon}
      draggable={draggable}
      eventHandlers={{
        dragend: () => {
          const m = ref.current;
          if (!m) return;
          const ll = m.getLatLng();
          onDragEnd?.(receiverKey, { lat: ll.lat, lng: ll.lng });
        },
      }}
    />
  );
}

// Concentric safety-distance rings around a receiver. Radii come in as
// metres (Leaflet's L.Circle units) so distances stay accurate at any
// zoom -- the projection handles it. Labels are non-interactive
// divIcons placed at the north cardinal point of each ring; clicks /
// drags pass through to the receiver pin underneath.
//
// At low zooms (< ~14) the rings collapse to a smear of overlapping
// pixels; we hide them in that case to keep the map readable.
function SafetyRings({ center, rings, mapZoom }) {
  if (
    !center ||
    !Number.isFinite(center.lat) ||
    !Number.isFinite(center.lng) ||
    !Array.isArray(rings) ||
    rings.length === 0
  ) {
    return null;
  }
  const visible = mapZoom == null || mapZoom >= 14;
  if (!visible) return null;

  // Equirectangular approx: ~111,320 m per degree of latitude. Plenty
  // accurate for the <100m radii we're drawing.
  const metersPerDegLat = 111320;

  return (
    <>
      {rings.map((r) => {
        const labelLat = center.lat + r.radiusM / metersPerDegLat;
        return (
          <React.Fragment key={`ring-${r.label}-${r.radiusM}`}>
            <>
              {/* Black halo for contrast against light and mixed backgrounds */}
              <Circle
                center={[center.lat, center.lng]}
                radius={r.radiusM}
                pathOptions={{
                  color: "#000000",
                  weight: 4,
                  opacity: 0.15,
                  fill: false,
                  interactive: false,
                }}
              />

              {/* Main orange dashed circle */}
              <Circle
                center={[center.lat, center.lng]}
                radius={r.radiusM}
                pathOptions={{
                  color: "#f47a38",      // armed orange
                  weight: 1.5,
                  opacity: 0.95,
                  fillColor: "#f47a38",
                  fillOpacity: 0.04,     // very subtle fill for visibility
                  dashArray: "3 4",
                  lineCap: "round",
                  interactive: false,
                }}
              />
            </>
            <Marker
              position={[labelLat, center.lng]}
              icon={makeRingLabelIcon(r.label)}
              interactive={false}
              keyboard={false}
            />
          </React.Fragment>
        );
      })}
    </>
  );
}

export default function SatelliteMap({
  center,
  zoom = 18,
  markers = [],
  draggable = true,
  onMarkerDragEnd,
  onMoveEnd,
  onMapReady,
  // Optional concentric safety rings drawn around every marker.
  // Pass an array of `{ radiusM, label }` -- e.g. NFPA "70 ft per inch
  // of shell diameter" rule of thumb fed in from SpatialLayoutMap.
  safetyRings = null,
  // Optional single pairwise-distance overlay (see DistanceHighlight).
  // Shape: `{ a: {lat,lng}, b: {lat,lng}, label?: string }`. Passing
  // null/undefined hides the overlay.
  highlight = null,
  height = "28rem",
  className,
}) {
  // Leaflet requires a non-zero initial center. Fall back to a neutral
  // ocean view (mid-Atlantic) if the parent hasn't supplied one yet --
  // the operator picks an address right after, which animates the map
  // into the right spot via MapView.
  const initial = useMemo(() => {
    if (center && Number.isFinite(center.lat) && Number.isFinite(center.lng)) {
      return [center.lat, center.lng];
    }
    return [20, -40];
  }, [center?.lat, center?.lng]);

  // Live zoom for the safety-ring visibility heuristic. Tracked here
  // instead of bubbled up so the parent doesn't re-render on every
  // zoom step.
  const [currentZoom, setCurrentZoom] = React.useState(zoom);

  return (
    <div
      className={className}
      style={{ height, width: "100%", borderRadius: 8, overflow: "hidden" }}
    >
      <MapContainer
        center={initial}
        zoom={zoom}
        style={{ height: "100%", width: "100%" }}
        scrollWheelZoom
        worldCopyJump
      >
        <TileLayer
          url={ESRI_WORLD_IMAGERY}
          attribution={ESRI_ATTRIBUTION}
          maxZoom={20}
        />
        <MapView center={center} zoom={zoom} />
        <MapEvents onMoveEnd={onMoveEnd} />
        <ZoomTracker onZoom={setCurrentZoom} />
        {onMapReady ? <MapReadyHandshake onReady={onMapReady} /> : null}
        {markers.map((m) =>
          m.position &&
          Number.isFinite(m.position.lat) &&
          Number.isFinite(m.position.lng) ? (
            <React.Fragment key={m.key}>
              {safetyRings ? (
                <SafetyRings
                  center={m.position}
                  rings={safetyRings}
                  mapZoom={currentZoom}
                />
              ) : null}
              <ReceiverMarker
                receiverKey={m.key}
                position={m.position}
                label={m.label}
                badge={m.badge}
                draggable={draggable}
                onDragEnd={onMarkerDragEnd}
              />
            </React.Fragment>
          ) : null
        )}
        {highlight ? (
          <DistanceHighlight
            a={highlight.a}
            b={highlight.b}
            label={highlight.label}
          />
        ) : null}
      </MapContainer>
    </div>
  );
}
