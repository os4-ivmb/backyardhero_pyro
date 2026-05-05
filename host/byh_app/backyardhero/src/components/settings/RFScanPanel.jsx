import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { MdClose, MdRadar, MdWarning } from "react-icons/md";
import useStateAppStore from "@/store/useStateAppStore";

// Wi-Fi 2.4 GHz channel centers in MHz (US chs 1-11, EU adds 12-13).
// Each Wi-Fi channel is ~22 MHz wide → ±11 from center hits nRF channels.
const WIFI_CHANNELS = [
  { ch: 1,  freq: 2412 },
  { ch: 6,  freq: 2437 },
  { ch: 11, freq: 2462 },
];

const NRF_BASE_MHZ = 2400;

// Map an nRF24 channel to its center frequency in MHz.
const nrfFreq = (ch) => NRF_BASE_MHZ + ch;

// Returns the Wi-Fi channel an nRF channel sits inside (or null if it doesn't).
function wifiBandFor(nrfCh) {
  const f = nrfFreq(nrfCh);
  for (const w of WIFI_CHANNELS) {
    if (Math.abs(f - w.freq) <= 11) return w.ch;
  }
  return null;
}

const wifiBandColor = (band) => {
  if (band === 1)  return "rgba(244, 114, 182, 0.18)";  // pink-ish
  if (band === 6)  return "rgba(96, 165, 250, 0.18)";   // blue-ish
  if (band === 11) return "rgba(251, 191, 36, 0.18)";   // amber-ish
  return null;
};

export default function RFScanPanel() {
  const { stateData } = useStateAppStore();

  const [open, setOpen] = useState(false);
  const [scan, setScan] = useState(null);     // last fetched scan payload
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState(null);
  const [passes, setPasses] = useState(10);
  // Tracks the timestamp we knew about *before* triggering a new scan, so we
  // can detect when the daemon has published a fresh result.
  const lastKnownTsRef = useRef(0);

  const currentChannel = stateData?.fw_state?.settings?.rf?.current_channel;
  const isShowLoaded   = !!stateData?.fw_state?.show_loaded;
  const isArmed        = !!stateData?.fw_state?.device_is_armed;
  const blockedReason  = isShowLoaded
    ? "Cannot scan while a show is loaded."
    : isArmed
      ? "Cannot scan while the system is armed."
      : null;

  // Pull the most recent scan from the API. 404 just means "no scan yet".
  const fetchLastScan = useCallback(async () => {
    try {
      const { data } = await axios.get("/api/system/rf_scan");
      setScan(data);
      lastKnownTsRef.current = data?.host_ts_ms || 0;
      setError(null);
      return data;
    } catch (e) {
      if (e?.response?.status === 404) {
        setScan(null);
        return null;
      }
      setError(e?.response?.data?.error || e.message);
      return null;
    }
  }, []);

  // When the modal opens, fetch the persisted scan once so the user sees
  // whatever was there last (even from a previous session).
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetchLastScan().finally(() => setLoading(false));
  }, [open, fetchLastScan]);

  const triggerScan = useCallback(async () => {
    if (blockedReason) return;
    setError(null);
    setScanning(true);
    try {
      // Snapshot the current ts so we can detect the new file.
      lastKnownTsRef.current = scan?.host_ts_ms || 0;
      await axios.post("/api/system/rf_scan", { passes });
      // Poll every 400ms for up to ~10s waiting for a fresher payload.
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 400));
        const fresh = await fetchLastScan();
        if (fresh && (fresh.host_ts_ms || 0) > lastKnownTsRef.current) {
          break;
        }
      }
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
    } finally {
      setScanning(false);
    }
  }, [blockedReason, passes, scan?.host_ts_ms, fetchLastScan]);

  const applyRecommended = useCallback(async () => {
    if (!scan?.recommended_ch) return;
    if (blockedReason) return;
    setError(null);
    try {
      await axios.post("/api/system/cmd_daemon", {
        type: "set_rf_channel",
        channel: scan.recommended_ch,
      });
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
    }
  }, [scan?.recommended_ch, blockedReason]);

  // Pre-compute max hit count so the bar widths are scaled within the chart.
  const { results, maxHits } = useMemo(() => {
    const r = scan?.results || [];
    let m = 0;
    for (const row of r) if (row.hits > m) m = row.hits;
    return { results: r, maxHits: m || 1 };
  }, [scan]);

  return (
    <div className="">
      <h2 className="text-lg text-white">RF Spectrum Scan</h2>
      <p className="text-gray-400 text-xs italic mt-1">
        Sample every nRF24 channel using the dongle's RPD register to find
        the least congested band. Picks up Wi-Fi, BLE, microwaves — anything
        radiating &gt; -64 dBm during the sweep.
      </p>

      <div className="flex items-center gap-3 mt-3 text-sm text-gray-200">
        <span>
          Current channel:{" "}
          <strong className="text-white">
            {currentChannel != null ? currentChannel : "—"}
          </strong>
          {currentChannel != null && (
            <span className="text-gray-400 ml-1">
              ({(NRF_BASE_MHZ + currentChannel) / 1000} GHz)
            </span>
          )}
        </span>
        <button
          onClick={() => setOpen(true)}
          className="ml-auto inline-flex items-center gap-2 bg-blue-900 hover:bg-blue-700 text-white text-sm font-bold py-2 px-3 rounded"
          type="button"
        >
          <MdRadar /> Open Scanner
        </button>
      </div>

      {open && (
        <ScanModal
          onClose={() => setOpen(false)}
          scan={scan}
          loading={loading}
          scanning={scanning}
          error={error}
          passes={passes}
          setPasses={setPasses}
          triggerScan={triggerScan}
          applyRecommended={applyRecommended}
          blockedReason={blockedReason}
          currentChannel={currentChannel}
          results={results}
          maxHits={maxHits}
        />
      )}
    </div>
  );
}

function ScanModal({
  onClose,
  scan,
  loading,
  scanning,
  error,
  passes,
  setPasses,
  triggerScan,
  applyRecommended,
  blockedReason,
  currentChannel,
  results,
  maxHits,
}) {
  const recommended = scan?.recommended_ch;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-lg shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <div className="flex items-center gap-2 text-white">
            <MdRadar className="text-xl" />
            <h3 className="text-lg font-bold">RF Spectrum Scan</h3>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white p-1"
            title="Close"
          >
            <MdClose className="text-xl" />
          </button>
        </div>

        <div className="p-4 flex flex-col gap-3 overflow-y-auto">
          {blockedReason && (
            <div className="flex items-center gap-2 px-3 py-2 bg-amber-900/40 border border-amber-700 text-amber-200 text-sm rounded">
              <MdWarning /> {blockedReason}
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 px-3 py-2 bg-red-900/40 border border-red-700 text-red-200 text-sm rounded">
              <MdWarning /> {error}
            </div>
          )}

          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm text-gray-200">
              <span className="text-xs text-gray-400">Passes</span>
              <input
                type="number"
                min={1}
                max={50}
                value={passes}
                onChange={(e) => setPasses(parseInt(e.target.value, 10) || 1)}
                className="w-24 bg-gray-800 text-white text-sm rounded border border-gray-600 px-2 py-1"
                disabled={scanning}
              />
            </label>
            <button
              onClick={triggerScan}
              disabled={scanning || !!blockedReason}
              className={`px-4 py-2 rounded text-white text-sm font-bold ${
                scanning || blockedReason
                  ? "bg-gray-600 cursor-not-allowed"
                  : "bg-emerald-600 hover:bg-emerald-700"
              }`}
            >
              {scanning ? "Scanning…" : "Run Scan"}
            </button>

            <div className="ml-auto text-xs text-gray-400">
              {scan?.host_ts_ms ? (
                <>Last scan: {new Date(scan.host_ts_ms).toLocaleString()}</>
              ) : loading ? (
                "Loading last scan…"
              ) : (
                "No scan on record yet."
              )}
            </div>
          </div>

          {scan && (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="bg-gray-800/60 border border-gray-700 rounded p-3">
                <div className="text-xs text-gray-400">Current channel</div>
                <div className="text-2xl font-bold text-white">
                  {currentChannel ?? "—"}
                </div>
                <div className="text-xs text-gray-500">
                  {currentChannel != null &&
                    `${(NRF_BASE_MHZ + currentChannel) / 1000} GHz`}
                </div>
              </div>
              <div className="bg-emerald-900/30 border border-emerald-700 rounded p-3">
                <div className="text-xs text-emerald-300">Recommended</div>
                <div className="text-2xl font-bold text-emerald-200">
                  {recommended ?? "—"}
                </div>
                <div className="text-xs text-emerald-400">
                  {recommended != null &&
                    `${(NRF_BASE_MHZ + recommended) / 1000} GHz`}
                </div>
                {recommended != null && recommended !== currentChannel && (
                  <button
                    onClick={applyRecommended}
                    disabled={!!blockedReason}
                    className={`mt-2 w-full text-xs font-bold py-1.5 px-2 rounded ${
                      blockedReason
                        ? "bg-gray-700 text-gray-400 cursor-not-allowed"
                        : "bg-emerald-600 hover:bg-emerald-500 text-white"
                    }`}
                  >
                    Apply ch {recommended}
                  </button>
                )}
              </div>
            </div>
          )}

          {scan?.top?.length > 0 && (
            <div className="text-sm text-gray-300">
              <div className="text-xs text-gray-400 mb-1">
                Top candidates (lowest neighborhood-weighted score wins)
              </div>
              <div className="flex gap-2 flex-wrap">
                {scan.top.map((t, i) => (
                  <span
                    key={t.ch}
                    className={`px-2 py-1 rounded text-xs font-mono ${
                      i === 0
                        ? "bg-emerald-700 text-white"
                        : "bg-gray-700 text-gray-200"
                    }`}
                    title={`hits=${t.hits}, score=${t.score}`}
                  >
                    ch {t.ch} · {t.hits}h
                  </span>
                ))}
              </div>
            </div>
          )}

          {results.length > 0 && (
            <ScanChart
              results={results}
              maxHits={maxHits}
              currentChannel={currentChannel}
              recommended={recommended}
            />
          )}

          {!loading && !scan && !scanning && (
            <div className="text-center text-gray-500 italic py-8">
              No scan available. Click <strong>Run Scan</strong> to sample the
              spectrum.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ScanChart({ results, maxHits, currentChannel, recommended }) {
  // Render a horizontal-channel chart: x-axis is nRF channel 0..125, y-axis
  // is hit count. We draw thin colored bars + Wi-Fi-band background swatches
  // so the operator can see at a glance where the dominant Wi-Fi APs sit.
  const W = 600;     // viewBox width
  const H = 220;     // viewBox height
  const padL = 28, padR = 8, padT = 8, padB = 22;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const xs = (ch) => padL + ((ch / 125) * innerW);
  const barW = innerW / 126 * 0.9;

  return (
    <div className="bg-gray-800/40 border border-gray-700 rounded p-2">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={260}>
        {/* Wi-Fi band swatches — rendered first so bars draw on top. */}
        {WIFI_CHANNELS.map((w) => {
          // freq bounds: w.freq ± 11 MHz, mapped to nRF channels
          const lo = Math.max(0, w.freq - 11 - NRF_BASE_MHZ);
          const hi = Math.min(125, w.freq + 11 - NRF_BASE_MHZ);
          const x = xs(lo);
          const width = xs(hi) - xs(lo);
          return (
            <g key={w.ch}>
              <rect
                x={x}
                y={padT}
                width={width}
                height={innerH}
                fill={wifiBandColor(w.ch)}
              />
              <text
                x={x + width / 2}
                y={padT + 12}
                fontSize="10"
                fill="#94a3b8"
                textAnchor="middle"
              >
                Wi-Fi {w.ch}
              </text>
            </g>
          );
        })}

        {/* y-axis ticks (max + half) */}
        <g>
          <line
            x1={padL}
            y1={padT}
            x2={padL}
            y2={padT + innerH}
            stroke="#475569"
            strokeWidth="1"
          />
          <line
            x1={padL}
            y1={padT + innerH}
            x2={padL + innerW}
            y2={padT + innerH}
            stroke="#475569"
            strokeWidth="1"
          />
          <text x={4} y={padT + 6} fontSize="9" fill="#94a3b8">
            {maxHits}
          </text>
          <text x={4} y={padT + innerH / 2 + 3} fontSize="9" fill="#94a3b8">
            {Math.round(maxHits / 2)}
          </text>
          <text x={4} y={padT + innerH + 4} fontSize="9" fill="#94a3b8">
            0
          </text>
        </g>

        {/* Channel bars */}
        {results.map((r) => {
          const h = (r.hits / maxHits) * innerH;
          const x = xs(r.ch) - barW / 2;
          const y = padT + (innerH - h);
          let fill = "#10b981"; // emerald — quiet
          if (r.hits > maxHits * 0.66) fill = "#ef4444";   // red — loud
          else if (r.hits > maxHits * 0.33) fill = "#f59e0b"; // amber
          return (
            <rect
              key={r.ch}
              x={x}
              y={y}
              width={barW}
              height={h}
              fill={fill}
            >
              <title>{`ch ${r.ch} · ${r.hits} hits · ${(NRF_BASE_MHZ + r.ch) / 1000} GHz`}</title>
            </rect>
          );
        })}

        {/* Current + recommended channel markers */}
        {currentChannel != null && (
          <g>
            <line
              x1={xs(currentChannel)}
              x2={xs(currentChannel)}
              y1={padT}
              y2={padT + innerH}
              stroke="#3b82f6"
              strokeWidth="1.5"
              strokeDasharray="3 3"
            />
            <text
              x={xs(currentChannel)}
              y={padT + innerH + 14}
              fill="#3b82f6"
              fontSize="9"
              textAnchor="middle"
            >
              now {currentChannel}
            </text>
          </g>
        )}
        {recommended != null && recommended !== currentChannel && (
          <g>
            <line
              x1={xs(recommended)}
              x2={xs(recommended)}
              y1={padT}
              y2={padT + innerH}
              stroke="#10b981"
              strokeWidth="1.5"
            />
            <text
              x={xs(recommended)}
              y={padT + innerH + 14}
              fill="#10b981"
              fontSize="9"
              textAnchor="middle"
            >
              best {recommended}
            </text>
          </g>
        )}

        {/* x-axis ticks every 25 channels */}
        {[0, 25, 50, 75, 100, 125].map((c) => (
          <text
            key={c}
            x={xs(c)}
            y={padT + innerH + 14}
            fill="#64748b"
            fontSize="9"
            textAnchor="middle"
          >
            {c}
          </text>
        ))}
      </svg>
      <div className="flex items-center justify-center gap-4 text-[10px] text-gray-400 mt-1">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-sm bg-emerald-500" /> quiet
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-sm bg-amber-500" /> moderate
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-sm bg-red-500" /> loud
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-3 h-1 bg-blue-500" /> current channel
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-3 h-1 bg-emerald-500" /> recommended
        </span>
      </div>
    </div>
  );
}
