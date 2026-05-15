import React, { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import useAppStore from "@/store/useAppStore";
import AddressSearch from "@/components/builder/AddressSearch";
import { Field, fieldHintClass, inputClass } from "@/design";
import SaveBar from "./SaveBar";

// Fleet-wide default location used to pre-seed the show builder's
// satellite layout map. Operators rarely change this -- it's the
// home base / launch site coords. Stored at the top level of
// systemcfg.json as `default_location: { lat, lng, zoom?, address? }`
// so it round-trips through the existing /api/system/config GET/POST.

const SatelliteMap = dynamic(
  () => import("@/components/builder/SatelliteMap"),
  { ssr: false }
);

function isValidCoord(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function normalizeFromConfig(cfg) {
  const dl = cfg?.default_location;
  if (!dl) return { lat: "", lng: "", zoom: 18, address: "" };
  return {
    lat: isValidCoord(dl.lat) ? dl.lat : "",
    lng: isValidCoord(dl.lng) ? dl.lng : "",
    zoom: isValidCoord(dl.zoom) ? dl.zoom : 18,
    address: typeof dl.address === "string" ? dl.address : "",
  };
}

export default function DefaultLocationSettings() {
  const { systemConfig, fetchSystemConfig, saveSystemConfig } = useAppStore();
  const [draft, setDraft] = useState(() => normalizeFromConfig(systemConfig));
  const [baseline, setBaseline] = useState(() =>
    JSON.stringify(normalizeFromConfig(systemConfig))
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [savedAt, setSavedAt] = useState(null);

  useEffect(() => {
    if (!systemConfig || Object.keys(systemConfig).length === 0) {
      fetchSystemConfig();
    }
  }, [fetchSystemConfig, systemConfig]);

  // Adopt upstream values on first load / when the operator hasn't
  // started editing yet. We compare via the stable JSON baseline so a
  // referentially-different upstream object with the same fields
  // doesn't yank an in-flight edit.
  useEffect(() => {
    const upstream = normalizeFromConfig(systemConfig);
    const upstreamSig = JSON.stringify(upstream);
    if (baseline === JSON.stringify(draft)) {
      setDraft(upstream);
      setBaseline(upstreamSig);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [systemConfig]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== baseline,
    [draft, baseline]
  );

  const previewCenter = useMemo(() => {
    const lat = parseFloat(draft.lat);
    const lng = parseFloat(draft.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  }, [draft.lat, draft.lng]);

  const onPick = ({ lat, lng, display }) => {
    setDraft((d) => ({
      ...d,
      lat,
      lng,
      address: display || d.address || "",
    }));
    setError(null);
  };

  const onMoveEnd = ({ lat, lng, zoom }) => {
    setDraft((d) => {
      // Avoid loops: only update on real changes.
      if (
        Math.abs((parseFloat(d.lat) || 0) - lat) < 1e-6 &&
        Math.abs((parseFloat(d.lng) || 0) - lng) < 1e-6 &&
        Math.abs((d.zoom ?? 0) - zoom) < 0.01
      ) {
        return d;
      }
      return { ...d, lat, lng, zoom };
    });
  };

  const onSave = async () => {
    setError(null);
    const lat = parseFloat(draft.lat);
    const lng = parseFloat(draft.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      setError("Latitude and longitude are required.");
      return;
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      setError("Coordinates out of range.");
      return;
    }
    const z = Number.isFinite(parseFloat(draft.zoom))
      ? parseFloat(draft.zoom)
      : 18;
    setSaving(true);
    try {
      const next = {
        ...(systemConfig || {}),
        default_location: {
          lat,
          lng,
          zoom: z,
          address: (draft.address || "").trim(),
        },
      };
      await saveSystemConfig(next);
      const sig = JSON.stringify({
        lat,
        lng,
        zoom: z,
        address: (draft.address || "").trim(),
      });
      setBaseline(sig);
      setSavedAt(Date.now());
    } catch (e) {
      console.error("Failed to save default_location:", e);
      setError(e?.response?.data?.error || e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const onClear = async () => {
    setError(null);
    setSaving(true);
    try {
      const next = { ...(systemConfig || {}) };
      delete next.default_location;
      await saveSystemConfig(next);
      const cleared = { lat: "", lng: "", zoom: 18, address: "" };
      setDraft(cleared);
      setBaseline(JSON.stringify(cleared));
      setSavedAt(Date.now());
    } catch (e) {
      console.error("Failed to clear default_location:", e);
      setError(e?.response?.data?.error || e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const onReset = () => {
    const upstream = normalizeFromConfig(systemConfig);
    setDraft(upstream);
    setError(null);
  };

  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Search a launch site"
        hint="Used as the starting view for the show editor's Receiver Layout map. Per-show layouts can override this."
      >
        <AddressSearch
          value={draft.address}
          onChange={(v) => setDraft((d) => ({ ...d, address: v }))}
          onPick={onPick}
          placeholder="Address, place, or paste lat,lng"
        />
      </Field>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field label="Latitude">
          <input
            type="number"
            step="any"
            min={-90}
            max={90}
            value={draft.lat}
            onChange={(e) =>
              setDraft((d) => ({ ...d, lat: e.target.value }))
            }
            className={`${inputClass} num`}
          />
        </Field>
        <Field label="Longitude">
          <input
            type="number"
            step="any"
            min={-180}
            max={180}
            value={draft.lng}
            onChange={(e) =>
              setDraft((d) => ({ ...d, lng: e.target.value }))
            }
            className={`${inputClass} num`}
          />
        </Field>
        <Field label="Default zoom" hint="Higher = closer (Esri max ≈ 20).">
          <input
            type="number"
            min={1}
            max={20}
            step={1}
            value={draft.zoom}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                zoom: parseInt(e.target.value, 10) || 1,
              }))
            }
            className={`${inputClass} num`}
          />
        </Field>
      </div>

      {previewCenter ? (
        <div>
          <p className={fieldHintClass + " mb-2"}>
            Pan / zoom the map to fine-tune the saved view.
          </p>
          <SatelliteMap
            center={previewCenter}
            zoom={draft.zoom || 18}
            markers={[]}
            onMoveEnd={onMoveEnd}
            height="22rem"
          />
        </div>
      ) : (
        <div className="w-full h-[22rem] bg-surface-inset rounded-md flex items-center justify-center text-fg-muted text-sm">
          Pick an address or enter coordinates to preview the map.
        </div>
      )}

      <SaveBar
        dirty={dirty}
        saving={saving}
        error={error}
        savedAt={savedAt}
        onSave={onSave}
        onReset={onReset}
      />
      {(systemConfig?.default_location || draft.lat || draft.lng) ? (
        <div className="flex justify-end -mt-1">
          <button
            type="button"
            onClick={onClear}
            disabled={saving}
            className="text-xs text-fg-muted hover:text-danger-fg underline-offset-2 hover:underline disabled:opacity-50"
          >
            Clear default location
          </button>
        </div>
      ) : null}
    </div>
  );
}
