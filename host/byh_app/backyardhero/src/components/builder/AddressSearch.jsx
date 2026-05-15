import React, { useEffect, useRef, useState } from "react";
import { MdSearch, MdMyLocation, MdClose } from "react-icons/md";
import { inputClass } from "@/design";

// Address / coordinate picker backed by OpenStreetMap's free Nominatim
// service. We deliberately do NOT autocomplete-as-you-type -- Nominatim's
// usage policy caps us at ~1 req/sec and asks that consumer apps avoid
// per-keystroke queries. The operator types and presses Enter (or the
// search button) to submit, then picks one result from the dropdown.
//
// Also accepts raw "lat,lng" pairs as a fast-path so a power user can
// paste coordinates straight in without going through geocoding.

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

function tryParseLatLng(raw) {
  if (!raw) return null;
  const m = raw.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

export default function AddressSearch({
  value,
  onChange,
  onPick,
  onUseCurrent,
  placeholder = "Address, place, or lat,lng",
  disabled,
  showUseCurrent = true,
  autoFocus,
}) {
  const [query, setQuery] = useState(value || "");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    setQuery(value || "");
  }, [value]);

  // Close the dropdown on outside click. Standard pattern.
  useEffect(() => {
    if (!open) return;
    const fn = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [open]);

  const runSearch = async () => {
    setError(null);
    const trimmed = query.trim();
    if (!trimmed) return;

    const coords = tryParseLatLng(trimmed);
    if (coords) {
      onPick?.({
        lat: coords.lat,
        lng: coords.lng,
        display: `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`,
      });
      setOpen(false);
      return;
    }
    if (trimmed.length < 3) {
      setError("Type at least 3 characters or paste lat,lng.");
      return;
    }
    setLoading(true);
    try {
      const url = `${NOMINATIM_URL}?q=${encodeURIComponent(trimmed)}&format=json&limit=8&addressdetails=0`;
      const res = await fetch(url, {
        headers: { Accept: "application/json", "Accept-Language": "en" },
      });
      if (!res.ok) throw new Error(`Lookup failed (${res.status})`);
      const data = await res.json();
      const mapped = data
        .map((r, i) => ({
          id: r.place_id ?? `${r.lat},${r.lon},${i}`,
          lat: parseFloat(r.lat),
          lng: parseFloat(r.lon),
          display: r.display_name,
        }))
        .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
      setResults(mapped);
      setOpen(true);
      if (mapped.length === 0) setError("No matches found.");
    } catch (e) {
      console.error("Geocode failed:", e);
      setError(
        "Couldn't reach the geocoding service. Try again, or paste lat,lng."
      );
    } finally {
      setLoading(false);
    }
  };

  const useGeolocation = () => {
    setError(null);
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError("Geolocation not available in this browser.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        onPick?.({
          lat,
          lng,
          display: `Current location: ${lat.toFixed(5)}, ${lng.toFixed(5)}`,
        });
        onUseCurrent?.({ lat, lng });
      },
      (err) => setError(err.message || "Geolocation denied."),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  };

  const clear = () => {
    setQuery("");
    setResults([]);
    setOpen(false);
    setError(null);
    onChange?.("");
  };

  return (
    <div ref={wrapRef} className="relative w-full">
      <div className="flex gap-1.5 items-stretch">
        <div className="relative flex-1">
          <input
            type="text"
            placeholder={placeholder}
            value={query}
            disabled={disabled}
            autoFocus={autoFocus}
            onChange={(e) => {
              setQuery(e.target.value);
              onChange?.(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                runSearch();
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
            className={`${inputClass} pr-7`}
          />
          {query ? (
            <button
              type="button"
              onClick={clear}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-fg-muted hover:text-fg-primary"
              title="Clear"
            >
              <MdClose />
            </button>
          ) : null}
        </div>
        <button
          type="button"
          onClick={runSearch}
          disabled={disabled || loading}
          className="h-9 px-3 inline-flex items-center gap-1.5 rounded bg-surface-2 border border-border text-fg-primary hover:bg-surface-3 disabled:opacity-50 text-sm"
        >
          <MdSearch />
          {loading ? "Searching…" : "Search"}
        </button>
        {showUseCurrent ? (
          <button
            type="button"
            onClick={useGeolocation}
            disabled={disabled}
            title="Use my current location"
            className="h-9 px-2 inline-flex items-center rounded bg-surface-2 border border-border text-fg-secondary hover:text-fg-primary hover:bg-surface-3 disabled:opacity-50"
          >
            <MdMyLocation />
          </button>
        ) : null}
      </div>

      {error ? (
        <p className="text-xs text-danger-fg mt-1">{error}</p>
      ) : null}

      {open && results.length > 0 ? (
        <ul className="absolute z-[1000] mt-1 w-full max-h-72 overflow-auto rounded bg-surface-2 border border-border shadow-lg">
          {results.map((r) => (
            <li
              key={r.id}
              onClick={() => {
                onPick?.(r);
                setQuery(r.display);
                onChange?.(r.display);
                setOpen(false);
              }}
              className="px-2.5 py-1.5 text-xs text-fg-primary hover:bg-surface-3 cursor-pointer leading-snug"
            >
              {r.display}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
