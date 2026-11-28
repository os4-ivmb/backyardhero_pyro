import React, { useState, useMemo } from 'react';
import {
  buildShellUsageCountsFromShowItems,
  buildShellUsageCountsFromRacks,
  mergeShellUsageCounts,
  shellPackShellKey
} from '../../utils/shellUsageCounts';

export default function CellShellSelector({
  isOpen,
  onClose,
  onSelect,
  cellData,
  inventory,
  isBatch = false,
  showItems,
  racks,
  // Stacking override for hosts that open the picker over a z-indexed
  // modal (the add-cue dialog sits at z 100+).
  zIndex,
  title,
  selectLabel
}) {
  const [selectedShellId, setSelectedShellId] = useState(cellData?.shellId || null);
  const [selectedShellNumber, setSelectedShellNumber] = useState(cellData?.shellNumber || null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedColor, setSelectedColor] = useState(null);
  const [filterShellPackId, setFilterShellPackId] = useState('');
  // "Direct" = the ignitor goes straight into the shell's lift charge rather
  // than its time fuse. Only for unfused cells: a direct cell can't be on a
  // fuse, and firing it skips the shell's fuse delay (lift delay only).
  const [direct, setDirect] = useState(!!cellData?.direct);
  // Shell descriptions are long; hide them by default to keep the list dense.
  const [showDescriptions, setShowDescriptions] = useState(false);
  const cellIsFused = !!cellData?.fuseId;

  // Get all aerial shells - include those with and without pack_shell_data
  const shellsWithPacks = useMemo(() => {
    if (!inventory || !Array.isArray(inventory)) {
      return [];
    }
    
    // Filter to only AERIAL_SHELL types
    const aerialShells = inventory.filter(item => item && item.type === 'AERIAL_SHELL');
    
    return aerialShells.map(item => {
      let shells = [];
      if (item.metadata) {
        try {
          // Metadata might already be parsed (from store) or might be a string
          const metadata = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;
          
          // Check for pack_shell_data
          if (metadata && typeof metadata === 'object') {
            const packData = metadata.pack_shell_data;
            if (packData && packData.shells && Array.isArray(packData.shells) && packData.shells.length > 0) {
              shells = packData.shells;
            }
          }
        } catch (e) {
          console.error('Error parsing shell metadata for item:', item.id, item.name, e);
          shells = [];
        }
      }
      return {
        ...item,
        shells: shells
      };
    });
  }, [inventory]);

  // Get all unique colors from all shells
  const availableColors = useMemo(() => {
    const colorSet = new Set();
    shellsWithPacks.forEach(item => {
      if (item.shells && Array.isArray(item.shells) && item.shells.length > 0) {
        item.shells.forEach(shell => {
          if (shell && shell.colors && Array.isArray(shell.colors) && shell.colors.length > 0) {
            shell.colors.forEach(color => {
              if (color && typeof color === 'string') {
                colorSet.add(color);
              }
            });
          }
        });
      }
    });
    return Array.from(colorSet).sort();
  }, [shellsWithPacks]);

  // Get all shells for display (filtered or all)
  const displayShells = useMemo(() => {
    const results = [];
    const hasColorFilter = selectedColor !== null;
    const hasEffectFilter = searchQuery.trim().length > 0;
    const query = searchQuery.toLowerCase().trim();

    shellsWithPacks.forEach(item => {
      // Filter by inventory item if specified
      if (filterShellPackId && item.id !== parseInt(filterShellPackId)) {
        return;
      }

      // If item has no shells, include it as "ANY" option
      if (!item.shells || item.shells.length === 0) {
        // Only include if no filters are active or if name matches
        if (!hasColorFilter && !hasEffectFilter) {
          results.push({
            item,
            shell: null,
            matchType: 'any',
            colorCount: 0
          });
        } else if (hasEffectFilter && item.name.toLowerCase().includes(query)) {
          results.push({
            item,
            shell: null,
            matchType: 'name',
            colorCount: 0
          });
        }
        return;
      }

      // Filtering to a single pack: offer "any shell from this pack" first.
      if (filterShellPackId) {
        results.push({
          item,
          shell: null,
          matchType: 'any',
          colorCount: 0,
          pinned: true
        });
      }

      // Search through each shell in the pack
      item.shells.forEach(shell => {
        let matches = true;
        let matchType = '';

        // Filter by color if selected
        if (hasColorFilter) {
          const hasColor = shell.colors && shell.colors.some(color => color === selectedColor);
          if (!hasColor) {
            matches = false;
          } else {
            matchType = 'color';
          }
        }

        // Filter by effect if search query provided
        if (hasEffectFilter && matches) {
          const effectMatch = shell.effects && shell.effects.some(effect => {
            return effect.toLowerCase().includes(query);
          });
          
          if (!effectMatch) {
            matches = false;
          } else {
            matchType = matchType ? `${matchType}, effect` : 'effect';
          }
        }

        // If no filters, show all shells
        if (!hasColorFilter && !hasEffectFilter) {
          matches = true;
        }

        if (matches) {
          results.push({
            item,
            shell,
            matchType: matchType || 'all',
            colorCount: shell?.colors?.length || 0
          });
        }
      });
    });

    // Sort by number of colors (lowest first), then by item name, then by shell number
    return results.sort((a, b) => {
      // Pinned entries ("any shell" for the filtered pack) lead the list.
      if (!!a.pinned !== !!b.pinned) {
        return a.pinned ? -1 : 1;
      }
      // First sort by color count
      if (a.colorCount !== b.colorCount) {
        return a.colorCount - b.colorCount;
      }
      // Then by item name
      const nameCompare = a.item.name.localeCompare(b.item.name);
      if (nameCompare !== 0) {
        return nameCompare;
      }
      // Finally by shell number (if both have shells)
      if (a.shell && b.shell) {
        return a.shell.number - b.shell.number;
      }
      // If one doesn't have a shell, put it last
      if (!a.shell) return 1;
      if (!b.shell) return -1;
      return 0;
    });
  }, [selectedColor, searchQuery, filterShellPackId, shellsWithPacks]);

  const shellUsageCounts = useMemo(
    () =>
      mergeShellUsageCounts(
        buildShellUsageCountsFromShowItems(showItems || []),
        buildShellUsageCountsFromRacks(racks || [])
      ),
    [showItems, racks]
  );

  const showUsageCounts = showItems != null || (racks?.length ?? 0) > 0;

  const handleSelect = () => {
    onSelect(selectedShellId, selectedShellNumber, direct && !cellIsFused);
  };

  const handleRemove = () => {
    onSelect(null, null);
  };

  if (!isOpen) return null;

  const selectedResult = displayShells.find(r => 
    r.item.id === selectedShellId && 
    (r.shell === null ? selectedShellNumber === null : r.shell.number === selectedShellNumber)
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50"
      style={zIndex != null ? { zIndex } : undefined}
    >
      <div className="bg-gray-800 text-white p-6 rounded shadow-lg w-[900px] max-h-[80vh] overflow-hidden relative z-50 flex flex-col">
        <h2 className="text-xl mb-4">{title || (isBatch ? 'Batch Assign Shell' : 'Select Shell')}</h2>
        
        {/* Filters */}
        <div className="mb-4 space-y-3">
          {/* Color Selection */}
          <div>
            <label className="block mb-2 text-sm">Filter by Color:</label>
            <div className="flex flex-wrap gap-2 max-h-24 overflow-y-auto p-2 bg-gray-700 rounded">
              <button
                onClick={() => setSelectedColor(null)}
                className={`px-3 py-1 rounded text-sm ${
                  selectedColor === null
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-600 text-gray-300 hover:bg-gray-500'
                }`}
              >
                All Colors
              </button>
              {availableColors.map((color, idx) => (
                <button
                  key={idx}
                  onClick={() => setSelectedColor(selectedColor === color ? null : color)}
                  className={`w-8 h-8 rounded border-2 ${
                    selectedColor === color
                      ? 'border-blue-400 ring-2 ring-blue-400'
                      : 'border-gray-600 hover:border-gray-400'
                  }`}
                  style={{ backgroundColor: color }}
                  title={color}
                />
              ))}
            </div>
          </div>

          {/* Effect Search and Shell Pack Filter */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block mb-2 text-sm">Search by Effect:</label>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full p-2 bg-gray-700 rounded"
                placeholder="e.g., peony, glitter, strobe"
              />
            </div>
            <div>
              <label className="block mb-2 text-sm">Filter by Shell Pack:</label>
              <select
                className="w-full p-2 bg-gray-700 rounded"
                value={filterShellPackId}
                onChange={(e) => setFilterShellPackId(e.target.value)}
              >
                <option value="">All Shell Packs</option>
                {shellsWithPacks.map(item => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Two Column Layout */}
        <div className="flex-1 grid grid-cols-2 gap-4 overflow-hidden">
          {/* Left Column: Shell List */}
          <div className="flex flex-col min-h-0 border-r border-gray-700 pr-4">
            <div className="flex-1 overflow-y-auto space-y-1.5">
              {displayShells.length > 0 ? (
                displayShells.map((result, idx) => {
                  const isSelected = result.item.id === selectedShellId &&
                    (result.shell === null ? selectedShellNumber === null : result.shell?.number === selectedShellNumber);
                  const usageKey = shellPackShellKey(
                    result.item.id,
                    result.shell?.number ?? null
                  );
                  const usedTotal = showUsageCounts ? shellUsageCounts.get(usageKey) || 0 : null;
                  const colors = result.shell?.colors || [];
                  const effects = result.shell?.effects || [];
                  const description = result.shell?.description;

                  return (
                    <div
                      key={`${result.item.id}_${result.shell?.number || 'any'}_${idx}`}
                      onClick={() => {
                        setSelectedShellId(result.item.id);
                        setSelectedShellNumber(result.shell?.number || null);
                      }}
                      className={`px-2.5 py-1.5 rounded cursor-pointer ${
                        isSelected ? 'bg-blue-600' : 'bg-gray-700 hover:bg-gray-600'
                      }`}
                    >
                      {/* Header: name | colors | shell # */}
                      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                        <div className="text-sm font-semibold truncate min-w-0">{result.item.name}</div>
                        <div className="flex gap-1 justify-center">
                          {colors.map((color, colorIdx) => (
                            <div
                              key={colorIdx}
                              className="w-4 h-4 rounded-sm border border-gray-600"
                              style={{ backgroundColor: color }}
                              title={color}
                            />
                          ))}
                        </div>
                        <div className="text-xs font-mono text-right text-gray-300 whitespace-nowrap">
                          {result.shell ? `#${result.shell.number}` : 'ANY'}
                        </div>
                      </div>
                      {showDescriptions && description && (
                        <div className="text-xs text-gray-300 mt-0.5">{description}</div>
                      )}
                      {/* Effects + footer (used count, bottom right) */}
                      {(effects.length > 0 || usedTotal !== null) && (
                        <div className="flex items-end justify-between gap-2 mt-0.5">
                          <div className="text-[11px] leading-tight text-gray-400 min-w-0">
                            {effects.length > 0
                              ? effects.join(', ')
                              : result.shell === null
                              ? 'Any shell from this pack'
                              : ''}
                          </div>
                          {usedTotal !== null && (
                            <div
                              className={`text-[11px] leading-tight font-medium whitespace-nowrap ${
                                usedTotal > 0 ? 'text-amber-400' : 'text-gray-500'
                              }`}
                            >
                              Used {usedTotal}×
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              ) : (
                <div className="text-center text-gray-400 py-8">
                  No shells found matching your filters
                </div>
              )}
            </div>
            <label className="flex items-center gap-2 pt-2 mt-2 border-t border-gray-700 text-xs text-gray-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showDescriptions}
                onChange={(e) => setShowDescriptions(e.target.checked)}
              />
              Show descriptions
            </label>
          </div>

          {/* Right Column: Selection Details */}
          <div className="overflow-y-auto flex flex-col">
            {selectedResult ? (
              <div className="space-y-4">
                <div>
                  <h3 className="text-lg font-semibold mb-2">{selectedResult.item.name}</h3>
                  {selectedResult.shell ? (
                    <>
                      <div className="text-sm text-gray-300 mb-2">
                        Shell #{selectedResult.shell.number}
                      </div>
                      {selectedResult.shell.description && (
                        <div className="text-sm text-gray-400 mb-3">
                          {selectedResult.shell.description}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="text-sm text-gray-300 mb-3">
                      ANY shell from this pack
                    </div>
                  )}
                  {showUsageCounts && selectedResult && (
                    <div
                      className={`text-sm mt-2 ${
                        (shellUsageCounts.get(
                          shellPackShellKey(
                            selectedResult.item.id,
                            selectedResult.shell?.number ?? null
                          )
                        ) || 0) > 0
                          ? 'text-amber-400'
                          : 'text-gray-500'
                      }`}
                    >
                      Used (racks + timeline):{' '}
                      {shellUsageCounts.get(
                        shellPackShellKey(
                          selectedResult.item.id,
                          selectedResult.shell?.number ?? null
                        )
                      ) || 0}
                      ×
                    </div>
                  )}
                </div>

                {selectedResult.shell && (
                  <>
                    <div>
                      <strong className="text-sm block mb-2">Colors:</strong>
                      <div className="flex gap-2 flex-wrap">
                        {selectedResult.shell.colors && selectedResult.shell.colors.length > 0 ? (
                          selectedResult.shell.colors.map((color, idx) => (
                            <div
                              key={idx}
                              className="w-12 h-12 rounded border-2 border-gray-600"
                              style={{ backgroundColor: color }}
                              title={color}
                            />
                          ))
                        ) : (
                          <span className="text-gray-400 text-sm">None</span>
                        )}
                      </div>
                    </div>

                    <div>
                      <strong className="text-sm block mb-2">Effects:</strong>
                      <div className="flex flex-wrap gap-1">
                        {selectedResult.shell.effects && selectedResult.shell.effects.length > 0 ? (
                          selectedResult.shell.effects.map((effect, idx) => (
                            <span
                              key={idx}
                              className="px-2 py-1 bg-gray-700 rounded text-xs"
                            >
                              {effect}
                            </span>
                          ))
                        ) : (
                          <span className="text-gray-400 text-sm">None</span>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="text-center text-gray-400 py-8">
                Select a shell from the list to view details
              </div>
            )}

            {/* Direct fire (ignitor in the lift charge, no fuse) */}
            <label
              className={`mt-auto pt-4 flex items-start gap-2 text-sm select-none ${
                cellIsFused ? 'text-gray-500 cursor-not-allowed' : 'text-gray-200 cursor-pointer'
              }`}
              title={cellIsFused ? 'This cell is on a fuse. Delete the fuse first to make it direct.' : undefined}
            >
              <input
                type="checkbox"
                className="mt-0.5"
                checked={direct && !cellIsFused}
                disabled={cellIsFused}
                onChange={(e) => setDirect(e.target.checked)}
              />
              <span>
                <span className="font-semibold">Direct</span> (ignitor in the lift charge)
                <span className="block text-xs text-gray-400">
                  {cellIsFused
                    ? 'This cell is on a fuse. Delete the fuse first to make it direct.'
                    : isBatch
                    ? "Can't be fused. Fires with no fuse delay, only lift delay. Fused cells in the selection are left as-is."
                    : "Can't be fused. Fires with no fuse delay, only lift delay."}
                </span>
              </span>
            </label>

            {/* Action Buttons */}
            <div className="flex gap-2 pt-4 mt-3 border-t border-gray-700">
              <button
                onClick={handleSelect}
                disabled={!selectedShellId}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed"
              >
                {selectLabel || (isBatch ? 'Assign to Selected Cells' : 'Select')}
              </button>
              {!isBatch && cellData && cellData.shellId && (
                <button
                  onClick={handleRemove}
                  className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
                >
                  Remove
                </button>
              )}
              <button
                onClick={onClose}
                className="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

