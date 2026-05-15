import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import dynamic from "next/dynamic";
import { MdSave, MdMyLocation, MdCenterFocusStrong } from "react-icons/md";

import useAppStore from "@/store/useAppStore";
import AddressSearch from "./AddressSearch";

// NFPA-1123 / Display Fireworks Operator's Handbook rule of thumb:
// minimum spectator stand-off is ~70 ft per inch of shell diameter. We
// draw concentric rings every 35 ft so each ring corresponds to a 0.5"
// step (35' → 0.5" shell, 70' → 1.0", ..., 175' → 2.5"). Rings are
// declared in metres because Leaflet's L.Circle takes radius in metres
// directly (it handles projection at any zoom).
const FT_PER_M = 3.28084;
const ftToM = (ft) => ft / FT_PER_M;

// Great-circle distance between two {lat,lng} points using the Haversine
// formula. Returns metres. For the scales we care about here (a few ft
// to a few hundred ft) the spherical-earth approximation is overkill in
// accuracy and trivially cheap.
const EARTH_RADIUS_M = 6371000;
function haversineMeters(a, b) {
  if (!a || !b) return NaN;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sLat = Math.sin(dLat / 2);
  const sLng = Math.sin(dLng / 2);
  const h =
    sLat * sLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sLng * sLng;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
const SAFETY_RINGS = [
  { ft: 35,  inches: 0.5 },
  { ft: 70,  inches: 1.0 },
  { ft: 105, inches: 1.5 },
  { ft: 140, inches: 2.0 },
  { ft: 175, inches: 2.5 },
].map((r) => ({
  radiusM: ftToM(r.ft),
  // Use a Unicode "prime" so it renders cleanly as inches without
  // having to escape a literal double-quote inside the divIcon HTML.
  label: `${r.inches.toString().replace(/\.0$/, "")}\u2033`,
}));

const SAFETY_RINGS_PREF_KEY = "byh.spatialLayoutMap.showSafetyRings";

// SatelliteMap pulls leaflet at module-load time (it touches `window`),
// so it has to be loaded client-only. next/dynamic + ssr:false is the
// canonical pattern.
const SatelliteMap = dynamic(() => import("./SatelliteMap"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[28rem] bg-surface-inset rounded-md flex items-center justify-center text-fg-muted text-sm">
      Loading map…
    </div>
  ),
});

// `receiverLocations` shape (per-show, persisted in shows.receiver_locations):
//   {
//     "_meta":  { lat, lng, zoom, address? },   // map view + display name
//     "RX001":  { lat, lng },                    // per-receiver position
//     "RX002":  { lat, lng },
//     ...
//   }
//
// The view metadata is what `_meta` exists for: when the operator
// reopens a saved show we want the satellite map to land on the same
// spot at the same zoom they were working at last time. Per-receiver
// entries are anchored to real-world coords -- panning / zooming the
// map doesn't move them, just like real racks on the ground.

const META_KEY = "_meta";

function isMeta(k) {
  return k === META_KEY;
}

function getMeta(receiverLocations) {
  return receiverLocations?.[META_KEY] || null;
}

// Spread receivers around the given center on a small grid so they're
// visible immediately. ~30m radius per ring step is a sensible default
// for backyard-show distances; the operator drags them onto the actual
// rack positions afterwards.
function seedPositionsAround(center, receiverKeys) {
  if (!center || !Array.isArray(receiverKeys) || receiverKeys.length === 0) {
    return {};
  }
  // ~1e-4 deg ≈ 11m at the equator. Good enough for a starting layout.
  const step = 0.0003;
  const cols = Math.ceil(Math.sqrt(receiverKeys.length));
  const out = {};
  receiverKeys.forEach((k, i) => {
    const r = Math.floor(i / cols) - Math.floor(cols / 2);
    const c = (i % cols) - Math.floor(cols / 2);
    out[k] = {
      lat: center.lat + r * step,
      lng:
        center.lng +
        (c * step) / Math.max(0.1, Math.cos((center.lat * Math.PI) / 180)),
    };
  });
  return out;
}

// Lay receivers out across the visible map bounds so they all land
// inside the current viewport regardless of zoom level. Used by the
// "Center zones in window" action -- the operator pans / zooms to the
// site, then clicks once and every pin appears on a grid that fits the
// chosen view (margin-padded so pins aren't flush with the edges).
function fitPositionsToBounds(bounds, receiverKeys, center) {
  if (
    !bounds ||
    !Array.isArray(receiverKeys) ||
    receiverKeys.length === 0 ||
    !center
  ) {
    return {};
  }
  if (receiverKeys.length === 1) {
    return { [receiverKeys[0]]: { lat: center.lat, lng: center.lng } };
  }
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const west = bounds.getWest();
  const east = bounds.getEast();
  // Shrink to ~70% of the viewport so pins sit comfortably inside.
  const padFrac = 0.15;
  const innerS = south + (north - south) * padFrac;
  const innerN = north - (north - south) * padFrac;
  const innerW = west + (east - west) * padFrac;
  const innerE = east - (east - west) * padFrac;

  const cols = Math.ceil(Math.sqrt(receiverKeys.length));
  const rows = Math.ceil(receiverKeys.length / cols);
  const out = {};
  receiverKeys.forEach((k, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    // Centre single-row / single-col gracefully so we don't divide by 0.
    const fx = cols > 1 ? c / (cols - 1) : 0.5;
    const fy = rows > 1 ? r / (rows - 1) : 0.5;
    out[k] = {
      lat: innerN - fy * (innerN - innerS),
      lng: innerW + fx * (innerE - innerW),
    };
  });
  return out;
}

const SpatialLayoutMap = ({
  receivers,
  items,
  receiverLocations,
  setReceiverLocations,
  onSaveLocations,
  showSaveButton = true,
}) => {
  const systemConfig = useAppStore((s) => s.systemConfig);
  const defaultLocation = systemConfig?.default_location || null;

  // Safety-ring overlay toggle. Persisted to localStorage so an
  // operator who hates them stays unbothered across reloads.
  const [showSafetyRings, setShowSafetyRings] = useState(true);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(SAFETY_RINGS_PREF_KEY);
    if (stored != null) setShowSafetyRings(stored === "1");
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      SAFETY_RINGS_PREF_KEY,
      showSafetyRings ? "1" : "0"
    );
  }, [showSafetyRings]);

  // Receivers that actually have items assigned — we don't litter the
  // map with cards for empty receivers.
  const activeReceivers = useMemo(() => {
    const keys = Object.keys(receivers || {});
    return keys.filter((receiverKey) => {
      const receiver = receivers[receiverKey];
      if (!receiver || !receiver.cues) return false;
      return items.some((item) =>
        Object.entries(receiver.cues).some(
          ([zone, targets]) =>
            item.zone === zone && targets.includes(item.target)
        )
      );
    });
  }, [receivers, items]);

  // Per-receiver assigned-item count (shown as the red badge on each pin).
  const itemCounts = useMemo(() => {
    const out = {};
    for (const k of activeReceivers) {
      const receiver = receivers[k];
      out[k] = items.filter((item) =>
        Object.entries(receiver.cues || {}).some(
          ([zone, targets]) =>
            item.zone === zone && targets.includes(item.target)
        )
      ).length;
    }
    return out;
  }, [activeReceivers, receivers, items]);

  // Resolve the current map center/zoom. Preference order:
  //   1. Per-show meta the operator has already picked.
  //   2. Fleet-wide default location from systemcfg.json.
  //   3. null -- the SatelliteMap shows a neutral world view and asks
  //      the operator to set a location.
  const center = useMemo(() => {
    const meta = getMeta(receiverLocations);
    if (meta && Number.isFinite(meta.lat) && Number.isFinite(meta.lng)) {
      return { lat: meta.lat, lng: meta.lng };
    }
    if (
      defaultLocation &&
      Number.isFinite(defaultLocation.lat) &&
      Number.isFinite(defaultLocation.lng)
    ) {
      return { lat: defaultLocation.lat, lng: defaultLocation.lng };
    }
    return null;
  }, [receiverLocations, defaultLocation]);

  const zoom = useMemo(() => {
    const meta = getMeta(receiverLocations);
    if (meta && Number.isFinite(meta.zoom)) return meta.zoom;
    if (defaultLocation && Number.isFinite(defaultLocation.zoom)) {
      return defaultLocation.zoom;
    }
    return 18;
  }, [receiverLocations, defaultLocation]);

  const addressLabel = useMemo(() => {
    const meta = getMeta(receiverLocations);
    if (meta?.address) return meta.address;
    if (defaultLocation?.address) return defaultLocation.address;
    return "";
  }, [receiverLocations, defaultLocation]);

  // Auto-seed: if we have a center but the map has receivers without
  // positions yet, drop them on a small grid around the center so
  // they're immediately visible & draggable. Runs only when the set of
  // unpositioned receivers changes; respects what the operator has
  // already placed.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!center) return;
    if (!Array.isArray(activeReceivers) || activeReceivers.length === 0) return;
    const missing = activeReceivers.filter(
      (k) =>
        !receiverLocations?.[k] ||
        !Number.isFinite(receiverLocations[k].lat) ||
        !Number.isFinite(receiverLocations[k].lng)
    );
    if (missing.length === 0) {
      seededRef.current = true;
      return;
    }
    const seed = seedPositionsAround(center, missing);
    setReceiverLocations((prev) => ({
      ...(prev || {}),
      ...seed,
    }));
    seededRef.current = true;
    // Intentionally not depending on receiverLocations to avoid an
    // infinite loop -- we only react to changes in the set of receivers
    // or the resolved center.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeReceivers, center?.lat, center?.lng]);

  const handleMarkerDragEnd = useCallback(
    (receiverKey, latlng) => {
      setReceiverLocations((prev) => ({
        ...(prev || {}),
        [receiverKey]: { lat: latlng.lat, lng: latlng.lng },
      }));
    },
    [setReceiverLocations]
  );

  const handleMoveEnd = useCallback(
    ({ lat, lng, zoom: z }) => {
      setReceiverLocations((prev) => {
        const meta = prev?.[META_KEY] || {};
        // Only write if something actually changed -- avoids a tight
        // re-render loop with the auto-save fingerprint.
        if (
          Math.abs((meta.lat ?? NaN) - lat) < 1e-6 &&
          Math.abs((meta.lng ?? NaN) - lng) < 1e-6 &&
          Math.abs((meta.zoom ?? NaN) - z) < 0.01
        ) {
          return prev;
        }
        return {
          ...(prev || {}),
          [META_KEY]: { ...meta, lat, lng, zoom: z },
        };
      });
    },
    [setReceiverLocations]
  );

  const handleAddressPick = useCallback(
    ({ lat, lng, display }) => {
      setReceiverLocations((prev) => {
        const meta = prev?.[META_KEY] || {};
        return {
          ...(prev || {}),
          [META_KEY]: {
            ...meta,
            lat,
            lng,
            zoom: meta.zoom ?? 18,
            address: display ?? meta.address ?? "",
          },
        };
      });
    },
    [setReceiverLocations]
  );

  const useDefaultLocation = useCallback(() => {
    if (!defaultLocation) return;
    handleAddressPick({
      lat: defaultLocation.lat,
      lng: defaultLocation.lng,
      display: defaultLocation.address || "Default location",
    });
  }, [defaultLocation, handleAddressPick]);

  // Held imperatively (not in state) so reading bounds on click doesn't
  // require a re-render. SatelliteMap calls onMapReady(map) once mounted
  // and onMapReady(null) on unmount.
  const mapRef = useRef(null);
  const handleMapReady = useCallback((map) => {
    mapRef.current = map;
  }, []);

  // "Center zones in window" -- snap every active receiver onto a grid
  // that fits inside whatever the map is currently showing. Useful when
  // the operator pans the map far away from the saved pins and wants to
  // pull them all back into view.
  const centerZonesInWindow = useCallback(() => {
    const map = mapRef.current;
    if (!map || activeReceivers.length === 0) return;
    const bounds = map.getBounds();
    const c = map.getCenter();
    const placed = fitPositionsToBounds(bounds, activeReceivers, {
      lat: c.lat,
      lng: c.lng,
    });
    if (Object.keys(placed).length === 0) return;
    setReceiverLocations((prev) => ({
      ...(prev || {}),
      ...placed,
    }));
  }, [activeReceivers, setReceiverLocations]);

  // Markers fed into the leaflet wrapper. Filtered to the set of
  // receivers with an actual position so we don't render stale meta
  // entries as pins.
  const markers = useMemo(() => {
    return activeReceivers
      .map((k) => ({
        key: k,
        label: k,
        badge: itemCounts[k] || 0,
        position: receiverLocations?.[k] || null,
      }))
      .filter((m) => m.position && Number.isFinite(m.position.lat));
  }, [activeReceivers, itemCounts, receiverLocations]);

  // Pairwise distance matrix (feet) between every positioned receiver.
  // Symmetric; diagonal is 0. We compute once whenever the set of
  // positioned receivers (or any of their positions) changes, and reuse
  // it both for the NxN grid and the "longest pair" summary.
  const distanceGrid = useMemo(() => {
    const N = markers.length;
    const matrix = Array.from({ length: N }, () => Array(N).fill(0));
    let maxFt = 0;
    let maxPair = null; // [labelA, labelB]
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const ft = haversineMeters(markers[i].position, markers[j].position) *
          FT_PER_M;
        matrix[i][j] = ft;
        matrix[j][i] = ft;
        if (ft > maxFt) {
          maxFt = ft;
          maxPair = [markers[i].label, markers[j].label];
        }
      }
    }
    return { matrix, maxFt, maxPair };
  }, [markers]);

  // Which distance-grid cell the operator is hovering, if any. Drives
  // the map overlay (line + midpoint label). Stored as the two marker
  // indices to keep equality cheap; the rendered overlay is derived
  // from this + the live `markers` / `distanceGrid` values, so a drag
  // on either receiver updates the line in real time while it's
  // highlighted.
  const [hoveredPair, setHoveredPair] = useState(null); // { i, j } | null

  // Resolve hoveredPair into the shape the SatelliteMap expects. Done
  // outside the JSX so we can cheaply guard against stale indices (e.g.
  // a receiver loses its position mid-hover -- the array shrinks and the
  // saved indices would be out of bounds).
  const mapHighlight = useMemo(() => {
    if (!hoveredPair) return null;
    const { i, j } = hoveredPair;
    if (
      i == null || j == null || i === j ||
      i < 0 || j < 0 ||
      i >= markers.length || j >= markers.length
    ) {
      return null;
    }
    const a = markers[i];
    const b = markers[j];
    if (!a?.position || !b?.position) return null;
    const ft = distanceGrid.matrix[i][j];
    return {
      a: a.position,
      b: b.position,
      label: `${Math.round(ft)} ft`,
    };
  }, [hoveredPair, markers, distanceGrid]);

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between mb-3 print:hidden gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-bold">Receiver Layout</h2>
          <p className="text-xs text-fg-muted">
            Drag receivers to their real-world rack positions. The view
            saves with the show.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label
            className="inline-flex items-center gap-1.5 text-xs text-fg-secondary cursor-pointer select-none"
            title="Concentric rings every 35 ft, labelled with the corresponding shell-diameter rule (70 ft per inch)."
          >
            <input
              type="checkbox"
              checked={showSafetyRings}
              onChange={(e) => setShowSafetyRings(e.target.checked)}
              className="h-3.5 w-3.5 accent-accent"
            />
            Safety rings
          </label>
          {showSaveButton && onSaveLocations ? (
            <button
              onClick={onSaveLocations}
              className="flex items-center gap-2 px-3 h-9 bg-surface-2 border border-border text-fg-primary rounded hover:bg-surface-3 text-sm"
            >
              <MdSave />
              Save Layout
            </button>
          ) : null}
        </div>
      </div>

      <div className="bg-surface-1 border border-border rounded-md p-3 print:border-0 print:p-0">
        <div className="flex flex-col sm:flex-row gap-2 mb-3 print:hidden">
          <div className="flex-1">
            <AddressSearch
              value={addressLabel}
              onChange={() => { /* free-typed text isn't authoritative */ }}
              onPick={handleAddressPick}
              placeholder="Search address, place, or paste lat,lng"
            />
          </div>
          {center && activeReceivers.length > 0 ? (
            <button
              type="button"
              onClick={centerZonesInWindow}
              title="Lay every receiver out on a grid that fits the current map view"
              className="h-9 px-3 inline-flex items-center gap-1.5 rounded bg-surface-2 border border-border text-fg-secondary hover:text-fg-primary hover:bg-surface-3 text-sm whitespace-nowrap"
            >
              <MdCenterFocusStrong />
              Center zones in window
            </button>
          ) : null}
          {defaultLocation ? (
            <button
              type="button"
              onClick={useDefaultLocation}
              title={
                defaultLocation.address
                  ? `Use default: ${defaultLocation.address}`
                  : "Use default location"
              }
              className="h-9 px-3 inline-flex items-center gap-1.5 rounded bg-surface-2 border border-border text-fg-secondary hover:text-fg-primary hover:bg-surface-3 text-sm whitespace-nowrap"
            >
              <MdMyLocation />
              Use default
            </button>
          ) : null}
        </div>

        {!center ? (
          <div className="w-full h-[28rem] bg-surface-inset rounded-md flex flex-col items-center justify-center text-center px-6 gap-2">
            <p className="text-sm text-fg-secondary">
              No location set yet.
            </p>
            <p className="text-xs text-fg-muted max-w-md">
              Use the search above to find your show site, or set a default
              location under <strong>Settings → Show config</strong> so future
              shows open here automatically.
            </p>
          </div>
        ) : (
          <SatelliteMap
            center={center}
            zoom={zoom}
            markers={markers}
            onMarkerDragEnd={handleMarkerDragEnd}
            onMoveEnd={handleMoveEnd}
            onMapReady={handleMapReady}
            safetyRings={showSafetyRings ? SAFETY_RINGS : null}
            highlight={mapHighlight}
          />
        )}

        {activeReceivers.length === 0 ? (
          <p className="text-xs text-fg-muted mt-3 print:hidden">
            No receivers with assigned items yet — pins will appear here as
            soon as cues are placed in the editor.
          </p>
        ) : (
          <p className="text-xs text-fg-muted mt-3 print:hidden">
            {activeReceivers.length} receiver
            {activeReceivers.length === 1 ? "" : "s"} on map. Numbers show
            assigned items per receiver. Edits auto-save with the show.
          </p>
        )}

        {/* Pairwise distances between every positioned receiver. Hidden
            behind a native <details> disclosure so it doesn't crowd the
            map for shows where the operator doesn't need it. Receivers
            without saved positions are excluded -- we can't compute a
            real-world distance for them. */}
        {markers.length >= 2 ? (
          <details className="mt-3 group print:hidden">
            <summary className="cursor-pointer text-xs text-fg-secondary hover:text-fg-primary inline-flex items-center gap-1.5 select-none">
              <span className="inline-block transition-transform group-open:rotate-90">
                ▶
              </span>
              Pairwise distances
              {distanceGrid.maxPair ? (
                <span className="text-fg-muted">
                  · longest {Math.round(distanceGrid.maxFt)} ft (
                  {distanceGrid.maxPair[0]} ↔ {distanceGrid.maxPair[1]})
                </span>
              ) : null}
            </summary>
            <div
              className="mt-2 overflow-x-auto"
              onMouseLeave={() => setHoveredPair(null)}
            >
              <table className="text-xs border-collapse">
                <thead>
                  <tr>
                    {/* Top-left corner: empty so column headers align
                        with the row of labels below it. Sticky-left so
                        the row labels stay readable when the table is
                        scrolled horizontally. */}
                    <th className="sticky left-0 z-10 bg-surface-1 border border-border px-2 py-1"></th>
                    {markers.map((colMarker, j) => {
                      const isActiveCol =
                        hoveredPair &&
                        (hoveredPair.i === j || hoveredPair.j === j);
                      return (
                        <th
                          key={colMarker.key}
                          className={
                            "border border-border px-2 py-1 font-mono font-normal text-center min-w-[4.5rem] " +
                            (isActiveCol
                              ? "bg-surface-2 text-fg-primary"
                              : "text-fg-secondary")
                          }
                        >
                          {colMarker.label}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {markers.map((rowMarker, i) => {
                    const isActiveRow =
                      hoveredPair &&
                      (hoveredPair.i === i || hoveredPair.j === i);
                    return (
                      <tr key={rowMarker.key}>
                        <th
                          className={
                            "sticky left-0 z-10 border border-border px-2 py-1 font-mono font-normal text-left " +
                            (isActiveRow
                              ? "bg-surface-2 text-fg-primary"
                              : "bg-surface-1 text-fg-secondary")
                          }
                        >
                          {rowMarker.label}
                        </th>
                        {markers.map((colMarker, j) => {
                          const isDiag = i === j;
                          // Symmetric: hover on (i,j) lights up (j,i)
                          // too, since they're the same measurement.
                          const isHovered =
                            !isDiag &&
                            hoveredPair &&
                            ((hoveredPair.i === i && hoveredPair.j === j) ||
                              (hoveredPair.i === j && hoveredPair.j === i));
                          return (
                            <td
                              key={colMarker.key}
                              onMouseEnter={
                                isDiag
                                  ? undefined
                                  : () => setHoveredPair({ i, j })
                              }
                              className={
                                "border border-border px-2 py-1 text-center tabular-nums transition-colors " +
                                (isDiag
                                  ? "text-fg-muted "
                                  : "text-fg-primary cursor-crosshair ") +
                                (isHovered
                                  ? "bg-yellow-500/20 ring-1 ring-yellow-400 "
                                  : "")
                              }
                              title={
                                isDiag
                                  ? ""
                                  : `${rowMarker.label} ↔ ${colMarker.label}: ${
                                      distanceGrid.matrix[i][j].toFixed(1)
                                    } ft`
                              }
                            >
                              {isDiag
                                ? "—"
                                : `${Math.round(distanceGrid.matrix[i][j])}`}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-1 text-[10px] text-fg-muted">
                Distances in feet (great-circle). Hover a cell to draw
                the line on the map above; drag receivers to update.
              </p>
            </div>
          </details>
        ) : null}
      </div>
    </div>
  );
};

export default SpatialLayoutMap;
