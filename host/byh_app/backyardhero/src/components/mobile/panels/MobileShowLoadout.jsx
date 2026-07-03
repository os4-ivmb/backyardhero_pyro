import React, { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { MdArrowBack, MdExpandMore, MdRadio } from "react-icons/md";
import { FaImage, FaBoxesStacked } from "react-icons/fa6";

import useAppStore from "@/store/useAppStore";
import useStateAppStore from "@/store/useStateAppStore";
import { Card, Section, Button, Badge, cn } from "@/design";
import { getTypeLabel } from "@/constants";
import { buildShowReceiverCueMap } from "@/util/showReceivers";
import {
  buildShellUsageCountsFromRackCellAssignments,
  buildShellUsageCountsFromShowItems,
  parseShellPackShellKey,
} from "@/utils/shellUsageCounts";

// ---------------------------------------------------------------------------
// MobileShowLoadout -- mobile twin of `receivers/ShowLoadout.jsx`.
//
// The desktop page is print-and-PDF-oriented (A4 layouts, html2canvas,
// 4-column cue grids). On a phone the operator just wants a portable
// reference to the gear they're physically wiring up.
//
// Sections, top-to-bottom:
//   * Receivers + cue assignments (collapsible per-receiver cards).
//   * Rack layouts -- per-rack mini grid with shell positions, fuse
//     lines (SVG overlay) and receiver:cue overlays. Cells are sized
//     down so a 4-wide rack fits on a phone, with horizontal scroll
//     for wider racks.
//   * Rack shells -- shells to grab, grouped by shell pack.
//   * Items to pack (cakes / fountains).
// ---------------------------------------------------------------------------

const CAKE_AND_FOUNTAIN_PACK_TYPES = new Set([
  "CAKE_FOUNTAIN", "CAKE_200G", "CAKE_350G", "CAKE_500G", "COMPOUND_CAKE",
]);

// Mobile rack grid sizing -- smaller than desktop (130×140) so a 4-wide
// rack fits on a typical phone viewport without scrolling. Wider racks
// scroll horizontally in their container.
const MOBILE_CELL_WIDTH = 88;
const MOBILE_CELL_HEIGHT = 100;
const MOBILE_CELL_GAP = 4;

function getShellDescriptionFromMetadata(shellData, shellNumber) {
  if (!shellData || shellNumber == null || shellNumber === 0) return null;
  try {
    const metadata = shellData.metadata
      ? (typeof shellData.metadata === "string"
          ? JSON.parse(shellData.metadata)
          : shellData.metadata)
      : null;
    const packShellData = metadata?.pack_shell_data;
    if (packShellData?.shells && packShellData.shells.length >= shellNumber) {
      return packShellData.shells[shellNumber - 1]?.description || null;
    }
  } catch {
    // ignore -- metadata may be missing or unparseable
  }
  return null;
}

function ReceiverLoadoutCard({ rcvKey, label, zone, cues, mapping }) {
  const [open, setOpen] = useState(true);
  const assignedCount = cues.filter((t) => mapping?.[zone]?.[t]).length;
  return (
    <Card padding="none" tone="raised" className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 h-12 flex items-center justify-between text-left"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2 min-w-0">
          <MdRadio className="text-fg-secondary shrink-0" aria-hidden />
          <div className="min-w-0">
            <div className="font-medium text-fg-primary truncate">
              {label && label !== rcvKey ? (
                <>{label} <span className="text-fg-muted text-xs">({rcvKey})</span></>
              ) : (
                rcvKey
              )}
            </div>
            <div className="text-2xs text-fg-muted">
              Zone {zone} · {assignedCount}/{cues.length} cues filled
            </div>
          </div>
        </div>
        <MdExpandMore className={cn("text-lg transition-transform", !open && "-rotate-90")} />
      </button>
      {open ? (
        <ul className="border-t border-border-subtle divide-y divide-border-subtle">
          {cues.length === 0 ? (
            <li className="px-4 py-3 text-fg-muted text-sm italic">
              No cues registered.
            </li>
          ) : cues.map((target) => {
            const item = mapping?.[zone]?.[target];
            return (
              <li key={target} className="px-4 py-2.5 flex items-center gap-3">
                <div className="w-8 h-8 rounded-sm bg-surface-1 border border-border-subtle flex items-center justify-center text-fg-muted text-xs font-mono shrink-0">
                  {target}
                </div>
                <div className="min-w-0 flex-1">
                  {item ? (
                    <>
                      <div className="font-medium text-fg-primary truncate text-sm">
                        {item.name || "(unnamed)"}
                      </div>
                      <div className="text-2xs text-fg-muted truncate">
                        {item.type ? getTypeLabel(item.type) : "—"}
                        {item.multiple > 1 ? ` · ×${item.multiple}` : ""}
                      </div>
                    </>
                  ) : (
                    <span className="text-fg-muted text-sm italic">Empty</span>
                  )}
                </div>
                {item?.image ? (
                  <div className="w-9 h-9 rounded-sm bg-surface-2 border border-border-subtle overflow-hidden shrink-0">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={item.image}
                      alt=""
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </Card>
  );
}

// One rack at a time: header strip + scrollable mini grid + fuse summary.
// The grid mirrors the desktop one (cells, fuse SVG overlay, receiver:cue
// labels) but uses smaller cells so it can be scanned on a phone.
function RackLayoutCard({ rack, inventory, cellToItemMap }) {
  const [open, setOpen] = useState(true);

  const cells = rack.cells || {};
  const fuses = rack.fuses || {};
  const rackCellMap = cellToItemMap[rack.id] || {};

  const getShellData = (shellId) => {
    if (!inventory || !shellId) return null;
    return inventory.find((it) => it.id === shellId) || null;
  };
  const getFuseData = (fuseId) => {
    if (!inventory || !fuseId) return null;
    return inventory.find(
      (it) => it.type === "FUSE" && it.id === parseInt(fuseId, 10)
    ) || null;
  };

  const cellW = MOBILE_CELL_WIDTH;
  const cellH = MOBILE_CELL_HEIGHT;
  const gap = MOBILE_CELL_GAP;
  const gridWidth = rack.x_rows * (cellW + gap) - gap;
  const gridHeight = rack.y_rows * (cellH + gap) - gap;

  const cellCenter = (x, y) => ({
    x: x * (cellW + gap) + cellW / 2,
    y: y * (cellH + gap) + cellH / 2,
  });

  const fuseLines = [];
  for (const [fuseId, fuse] of Object.entries(fuses)) {
    if (!fuse.cells || fuse.cells.length < 2) continue;
    const fuseItem = getFuseData(fuse.type);
    const stroke = fuseItem?.color || "#FFD700";
    for (let i = 0; i < fuse.cells.length - 1; i += 1) {
      const [x1, y1] = fuse.cells[i].split("_").map(Number);
      const [x2, y2] = fuse.cells[i + 1].split("_").map(Number);
      const a = cellCenter(x1, y1);
      const b = cellCenter(x2, y2);
      fuseLines.push(
        <line
          key={`${fuseId}_${i}`}
          x1={a.x}
          y1={a.y}
          x2={b.x}
          y2={b.y}
          stroke={stroke}
          strokeWidth="3"
          strokeLinecap="round"
        />
      );
    }
  }

  const fuseEntries = Object.entries(fuses);

  return (
    <Card padding="none" tone="raised" className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 h-12 flex items-center justify-between text-left"
        aria-expanded={open}
      >
        <div className="min-w-0">
          <div className="font-medium text-fg-primary truncate">{rack.name}</div>
          <div className="text-2xs text-fg-muted">
            {rack.x_rows} × {rack.y_rows} grid
            {rack.x_spacing && rack.y_spacing
              ? ` · ${rack.x_spacing}″ × ${rack.y_spacing}″ spacing`
              : ""}
          </div>
        </div>
        <MdExpandMore className={cn("text-lg transition-transform shrink-0", !open && "-rotate-90")} />
      </button>

      {open ? (
        <div className="border-t border-border-subtle">
          {/* Grid (horizontally scrollable for wider racks) */}
          <div className="overflow-x-auto p-3 bg-gray-900">
            <div className="relative inline-block" style={{ width: gridWidth }}>
              <div
                className="grid relative"
                style={{
                  gridTemplateColumns: `repeat(${rack.x_rows}, ${cellW}px)`,
                  gap: `${gap}px`,
                  width: `${gridWidth}px`,
                }}
              >
                <svg
                  className="absolute inset-0 pointer-events-none"
                  style={{
                    width: `${gridWidth}px`,
                    height: `${gridHeight}px`,
                    zIndex: 2,
                  }}
                >
                  {fuseLines}
                </svg>

                {Array.from({ length: rack.y_rows }).map((_, y) =>
                  Array.from({ length: rack.x_rows }).map((_, x) => {
                    const cellKey = `${x}_${y}`;
                    const cellData = cells[cellKey];
                    const cellMapping = rackCellMap[cellKey];
                    const shellData = cellData?.shellId ? getShellData(cellData.shellId) : null;
                    const shellDescription = shellData && cellData?.shellNumber
                      ? getShellDescriptionFromMetadata(shellData, cellData.shellNumber)
                      : null;

                    return (
                      <div
                        key={cellKey}
                        className={cn(
                          "border-2 rounded p-1 relative overflow-hidden",
                          cellMapping
                            ? "border-blue-500 bg-blue-900/20"
                            : cellData?.shellId
                              ? "border-gray-500 bg-gray-800"
                              : "border-gray-700 bg-gray-900"
                        )}
                        style={{
                          width: `${cellW}px`,
                          height: `${cellH}px`,
                          zIndex: 1,
                        }}
                      >
                        {cellMapping ? (
                          <div
                            className="absolute top-0.5 right-0.5 text-[9px] text-blue-200 text-right leading-tight"
                            style={{ zIndex: 4 }}
                          >
                            <div className="font-semibold whitespace-nowrap truncate max-w-[60px]">
                              {cellMapping.receiverName}
                            </div>
                            <div className="text-blue-300 whitespace-nowrap">
                              {cellMapping.zone}:{cellMapping.target}
                            </div>
                          </div>
                        ) : null}

                        <div className="text-[9px] text-gray-500 leading-none mb-1">
                          ({x},{y})
                        </div>

                        {shellData ? (
                          <div className="flex flex-col items-center text-center">
                            {shellData.image ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={shellData.image}
                                alt=""
                                className="w-6 h-6 object-cover rounded border border-gray-600 mb-0.5"
                                loading="lazy"
                              />
                            ) : null}
                            <div className="text-[10px] text-gray-100 font-semibold leading-tight line-clamp-2">
                              {shellData.name}
                            </div>
                            {cellData.shellNumber ? (
                              <div className="text-[9px] text-gray-400 leading-tight">
                                #{cellData.shellNumber}
                              </div>
                            ) : null}
                            {shellDescription ? (
                              <div className="text-[9px] text-gray-300 italic leading-tight line-clamp-2 mt-0.5">
                                {shellDescription}
                              </div>
                            ) : null}
                          </div>
                        ) : (
                          <div className="text-[10px] text-gray-600 italic text-center mt-2">
                            Empty
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          {/* Fuse summary -- list of fuses that run through this rack. */}
          {fuseEntries.length > 0 ? (
            <div className="px-4 py-3 bg-surface-1 border-t border-border-subtle">
              <div className="text-2xs uppercase tracking-wide text-fg-muted mb-2">
                Fuses
              </div>
              <ul className="space-y-1.5">
                {fuseEntries.map(([fuseId, fuse]) => {
                  const fuseItem = getFuseData(fuse.type);
                  if (!fuseItem) return null;
                  let totalLen = fuse.leadIn || 0;
                  if (fuse.cells && fuse.cells.length > 1) {
                    for (let i = 0; i < fuse.cells.length - 1; i += 1) {
                      const [x1, y1] = fuse.cells[i].split("_").map(Number);
                      const [x2, y2] = fuse.cells[i + 1].split("_").map(Number);
                      const xd = Math.abs(x2 - x1);
                      const yd = Math.abs(y2 - y1);
                      totalLen += (xd * (rack.x_spacing || 0)) + (yd * (rack.y_spacing || 0));
                    }
                  }
                  const totalLenWithMargin = totalLen + 1; // 1" safety margin
                  return (
                    <li
                      key={fuseId}
                      className="flex items-center gap-2 text-xs text-fg-secondary"
                    >
                      <span
                        className="w-3 h-3 rounded-full border border-border-subtle shrink-0"
                        style={{ backgroundColor: fuseItem.color || "#FFD700" }}
                      />
                      <span className="font-medium text-fg-primary truncate">
                        {fuseItem.name}
                      </span>
                      <span className="text-fg-muted ml-auto whitespace-nowrap">
                        {totalLenWithMargin.toFixed(2)}″
                        {fuse.cells?.length ? ` · ${fuse.cells.length} cells` : ""}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

function ShellPackCard({ pack }) {
  const total = pack.shells.reduce((sum, row) => sum + row.count, 0);
  return (
    <Card padding="none" tone="raised" className="overflow-hidden">
      <div className="px-4 h-11 flex items-center justify-between border-b border-border-subtle">
        <div className="font-medium text-fg-primary truncate">{pack.packName}</div>
        <Badge tone="neutral">×{total}</Badge>
      </div>
      <ul className="divide-y divide-border-subtle">
        {pack.shells.map((row) => (
          <li
            key={row.shellNumber === null ? "any" : row.shellNumber}
            className="px-4 py-2 flex items-baseline gap-3 text-sm"
          >
            <span className="font-mono text-fg-secondary shrink-0 w-8">
              ×{row.count}
            </span>
            <span className="font-semibold text-fg-primary shrink-0">
              {row.shellNumber != null ? `#${row.shellNumber}` : "# (any)"}
            </span>
            {row.description ? (
              <span className="text-fg-muted text-xs break-words min-w-0">
                {row.description}
              </span>
            ) : (
              <span className="text-fg-muted text-xs italic">No description</span>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function PackList({ items }) {
  if (!items.length) {
    return (
      <Card padding="lg" tone="neutral" className="text-center">
        <p className="text-fg-muted text-sm">
          No cakes / fountains to pack for this show.
        </p>
      </Card>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {items.map((it) => (
        <li
          key={`${it.name}-${it.type}`}
          className="flex items-center gap-3 px-3 py-2 rounded-md border border-border-subtle bg-surface-1"
        >
          <div className="w-10 h-10 rounded-sm bg-surface-2 border border-border-subtle overflow-hidden shrink-0 flex items-center justify-center text-fg-muted">
            {it.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={it.image}
                alt=""
                className="w-full h-full object-cover"
                loading="lazy"
              />
            ) : (
              <FaImage aria-hidden />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-medium text-fg-primary truncate text-sm">
              {it.name}
            </div>
            <div className="text-2xs text-fg-muted truncate">
              {getTypeLabel(it.type)}
            </div>
          </div>
          <Badge tone="neutral">×{it.count}</Badge>
        </li>
      ))}
    </ul>
  );
}

export default function MobileShowLoadout({ setCurrentTab }) {
  const { systemConfig, stagedShow, inventory } = useAppStore();
  const { stateData } = useStateAppStore();
  const [targetRcvMap, setTargetRcvMap] = useState({});
  const [showReceivers, setShowReceivers] = useState({});
  const [receiverLabels, setReceiverLabels] = useState({});
  const [racks, setRacks] = useState([]);
  const [cellToItemMap, setCellToItemMap] = useState({});

  useEffect(() => {
    if (stagedShow?.receiverLabels) {
      setReceiverLabels(stagedShow.receiverLabels);
    } else if (stagedShow?.receiver_labels) {
      try { setReceiverLabels(JSON.parse(stagedShow.receiver_labels)); }
      catch { setReceiverLabels({}); }
    } else {
      setReceiverLabels({});
    }
  }, [stagedShow]);

  // Fetch racks for the staged show -- mirrors desktop ShowLoadout. The
  // mobile view doesn't let you edit racks, but we still want the same
  // rack/shell visualisation an operator would see on the printed sheet.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!stagedShow?.id) {
        setRacks([]);
        return;
      }
      try {
        const showId = parseInt(stagedShow.id, 10);
        const response = await axios.get("/api/racks", { params: { show_id: showId } });
        if (!cancelled) setRacks(response.data || []);
      } catch (error) {
        if (!cancelled) setRacks([]);
        // eslint-disable-next-line no-console
        console.error("MobileShowLoadout: failed to fetch racks", error);
      }
    };
    run();
    return () => { cancelled = true; };
  }, [stagedShow?.id]);

  // Build receiver -> zone -> cue -> item map. Same algorithm as desktop.
  useEffect(() => {
    // Size receivers by the show's designated cue counts (matches the show
    // editor's target grid), not the physical hardware cue map.
    let hardwareReceivers = systemConfig?.receivers || {};
    if (stateData.fw_state?.receivers) {
      hardwareReceivers = stateData.fw_state.receivers;
    }
    const receiversTmp = buildShowReceiverCueMap(
      hardwareReceivers,
      stagedShow?.showReceivers
    );

    const lookup = {};
    Object.keys(receiversTmp).forEach((rcvKey) => {
      const r = receiversTmp[rcvKey];
      Object.keys(r.cues || {}).forEach((zoneKey) => {
        r.cues[zoneKey].forEach((target) => {
          lookup[`${zoneKey}:${target}`] = rcvKey;
        });
      });
    });

    if (stagedShow?.items) {
      const map = {};
      stagedShow.items.forEach((payloadItem) => {
        const { zone, target } = payloadItem;
        const rcvKey = lookup[`${zone}:${target}`];
        if (rcvKey) {
          if (!map[rcvKey]) map[rcvKey] = {};
          if (!map[rcvKey][zone]) map[rcvKey][zone] = {};
          map[rcvKey][zone][target] = payloadItem;
        }
      });
      setTargetRcvMap(map);

      const filtered = {};
      Object.keys(receiversTmp).forEach((rcvKey) => {
        if (map[rcvKey] && Object.keys(map[rcvKey]).length > 0) {
          filtered[rcvKey] = receiversTmp[rcvKey];
        }
      });
      setShowReceivers(filtered);
    } else {
      setTargetRcvMap({});
      setShowReceivers({});
    }
  }, [systemConfig?.receivers, stagedShow, stateData.fw_state?.receivers]);

  // Build rack-cell -> { item, receiver, cue } mapping, so each rack
  // cell knows which receiver/zone/target wired it.
  useEffect(() => {
    if (!stagedShow?.items || !racks.length) {
      setCellToItemMap({});
      return;
    }

    let hardwareReceivers = systemConfig?.receivers || {};
    if (stateData.fw_state?.receivers) {
      hardwareReceivers = stateData.fw_state.receivers;
    }
    const receiversTmp = buildShowReceiverCueMap(
      hardwareReceivers,
      stagedShow?.showReceivers
    );

    const lookup = {};
    Object.keys(receiversTmp).forEach((rcvKey) => {
      const r = receiversTmp[rcvKey];
      Object.keys(r.cues || {}).forEach((zoneKey) => {
        r.cues[zoneKey].forEach((target) => {
          lookup[`${zoneKey}:${target}`] = rcvKey;
        });
      });
    });

    const cellMap = {};
    racks.forEach((rack) => {
      const cells = rack.cells || {};
      stagedShow.items.forEach((item) => {
        const itemRackId = parseInt(item.rackId, 10);
        const rackIdNum = parseInt(rack.id, 10);
        if (item.type === "RACK_SHELLS" && item.rackCells && itemRackId === rackIdNum) {
          const rcvKey = lookup[`${item.zone}:${item.target}`];
          item.rackCells.forEach((cellKey) => {
            if (cells[cellKey]) {
              if (!cellMap[rack.id]) cellMap[rack.id] = {};
              cellMap[rack.id][cellKey] = {
                item,
                receiverKey: rcvKey,
                receiverName: receiverLabels[rcvKey] || rcvKey,
                zone: item.zone,
                target: item.target,
              };
            }
          });
        }
      });
    });
    setCellToItemMap(cellMap);
  }, [
    stagedShow?.items,
    stagedShow?.showReceivers,
    racks,
    systemConfig?.receivers,
    stateData.fw_state?.receivers,
    receiverLabels,
  ]);

  const itemsToPack = useMemo(() => {
    if (!stagedShow?.items) return [];
    const itemCounts = {};
    const addToPack = (entry, qty) => {
      if (!entry || !CAKE_AND_FOUNTAIN_PACK_TYPES.has(entry.type)) return;
      const key = `${entry.name}-${entry.type}`;
      if (!itemCounts[key]) {
        const inv = entry.itemId != null
          ? inventory?.find((it) => it.id === entry.itemId)
          : null;
        itemCounts[key] = {
          name: entry.name,
          type: entry.type,
          itemId: entry.itemId,
          image: entry.image || inv?.image || null,
          count: 0,
        };
      }
      itemCounts[key].count += qty;
    };
    stagedShow.items.forEach((item) => {
      if (item.type === "FUSED_LINE" && Array.isArray(item.steps)) {
        item.steps.forEach((step) => {
          const qty = Number.isFinite(step.multiple) && step.multiple >= 1
            ? step.multiple : 1;
          addToPack(step, qty);
        });
        return;
      }
      const qty = Number.isFinite(item.multiple) && item.multiple >= 1
        ? item.multiple : 1;
      addToPack(item, qty);
    });
    return Object.values(itemCounts).sort((a, b) => a.name.localeCompare(b.name));
  }, [stagedShow?.items, inventory]);

  // Group rack-shell usage by shell pack -- same shape as the desktop
  // "Shells" section: pack -> [{ shellNumber, count, description }].
  const shellsToPackByPack = useMemo(() => {
    // Prefer the physical rack cells the RACK_SHELLS cues point at; if those
    // racks aren't available, fall back to the shell snapshot each cue persists
    // in fireableItem.cellData so counts still render (see ShowLoadout.jsx).
    let usage = buildShellUsageCountsFromRackCellAssignments(stagedShow?.items, racks);
    if (!usage.size) {
      usage = buildShellUsageCountsFromShowItems(stagedShow?.items);
    }
    if (!usage.size) return [];

    const packShells = new Map();
    for (const [usageKey, count] of usage.entries()) {
      const parsed = parseShellPackShellKey(usageKey);
      if (!parsed) continue;
      const { shellId, shellNumber } = parsed;
      const idKey = String(shellId);
      if (!packShells.has(idKey)) packShells.set(idKey, new Map());
      const numKey = shellNumber === null ? "any" : shellNumber;
      const inner = packShells.get(idKey);
      inner.set(numKey, (inner.get(numKey) || 0) + count);
    }

    return [...packShells.entries()]
      .map(([idKey, shellNumMap]) => {
        const shellData =
          (inventory || []).find(
            (inv) => String(inv.id) === idKey || inv.id === Number(idKey)
          ) || null;
        const packName = shellData?.name || `Shell pack (${idKey})`;
        const shells = [...shellNumMap.entries()]
          .map(([snKey, c]) => {
            const shellNumber = snKey === "any" ? null : snKey;
            return {
              shellNumber,
              count: c,
              description: getShellDescriptionFromMetadata(shellData, shellNumber),
            };
          })
          .sort((a, b) => {
            if (a.shellNumber == null && b.shellNumber == null) return 0;
            if (a.shellNumber == null) return 1;
            if (b.shellNumber == null) return -1;
            return a.shellNumber - b.shellNumber;
          });
        return { idKey, packName, shells };
      })
      .filter((p) => p.shells.length > 0)
      .sort((a, b) => a.packName.localeCompare(b.packName));
  }, [stagedShow?.items, racks, inventory]);

  if (!stagedShow) {
    return (
      <div className="px-4 py-8">
        <Card padding="lg" tone="neutral" className="text-center">
          <h2 className="text-lg font-semibold text-fg-primary mb-2">Show Loadout</h2>
          <p className="text-fg-muted text-sm">
            No show is staged yet. Stage one on the Console tab to view its
            loadout.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="px-3 py-3 space-y-4">
      {setCurrentTab ? (
        <button
          type="button"
          onClick={() => setCurrentTab("main")}
          className="inline-flex items-center gap-1 text-fg-secondary text-sm hover:text-fg-primary"
        >
          <MdArrowBack /> Back to Console
        </button>
      ) : null}

      <Section
        title="Show loadout"
        description={stagedShow.name}
      >
        <div className="text-2xs text-fg-muted">
          {Object.keys(showReceivers).length} receiver
          {Object.keys(showReceivers).length === 1 ? "" : "s"} ·
          {" "}{stagedShow.items?.length || 0} cues ·
          {" "}{racks.length} rack{racks.length === 1 ? "" : "s"}
        </div>
      </Section>

      <Section title="Receivers">
        <div className="flex flex-col gap-2">
          {Object.keys(showReceivers).length === 0 ? (
            <Card padding="lg" tone="neutral" className="text-center">
              <p className="text-fg-muted text-sm">
                None of this show's cues map onto known receivers.
              </p>
            </Card>
          ) : Object.keys(showReceivers).map((rcvKey) => {
            const receiver = showReceivers[rcvKey];
            const firstZone = Object.keys(receiver.cues || {})[0];
            const cues = (firstZone && receiver.cues?.[firstZone]) || [];
            return (
              <ReceiverLoadoutCard
                key={rcvKey}
                rcvKey={rcvKey}
                label={receiverLabels[rcvKey] || rcvKey}
                zone={firstZone}
                cues={cues}
                mapping={targetRcvMap[rcvKey]}
              />
            );
          })}
        </div>
      </Section>

      <Section
        title="Rack layouts"
        description="Cells, shells, fuse runs and the receiver:cue each cell fires."
      >
        <div className="flex flex-col gap-2">
          {racks.length === 0 ? (
            <Card padding="lg" tone="neutral" className="text-center">
              <p className="text-fg-muted text-sm">
                No racks attached to this show.
              </p>
            </Card>
          ) : racks.map((rack) => (
            <RackLayoutCard
              key={rack.id}
              rack={rack}
              inventory={inventory}
              cellToItemMap={cellToItemMap}
            />
          ))}
        </div>
      </Section>

      <Section
        title="Rack shells to grab"
        description="Shells needed for assigned rack cells, grouped by pack."
      >
        <div className="flex flex-col gap-2">
          {shellsToPackByPack.length === 0 ? (
            <Card padding="lg" tone="neutral" className="text-center">
              <p className="text-fg-muted text-sm">
                No rack shell usage in this show.
              </p>
            </Card>
          ) : shellsToPackByPack.map((pack) => (
            <ShellPackCard key={pack.idKey} pack={pack} />
          ))}
        </div>
      </Section>

      <Section
        title="Items to pack"
        description="Cakes and fountains needed for this show."
      >
        <PackList items={itemsToPack} />
      </Section>

      {setCurrentTab ? (
        <div className="pt-2">
          <Button
            size="md"
            variant="outline"
            leading={<FaBoxesStacked />}
            className="w-full"
            onClick={() => setCurrentTab("receivers")}
          >
            Open receivers
          </Button>
        </div>
      ) : null}
    </div>
  );
}
