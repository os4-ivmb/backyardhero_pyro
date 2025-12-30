import React, { useState, useMemo } from 'react';

export default function CellShellSelector({ isOpen, onClose, onSelect, cellData, inventory, isBatch = false, showItems = [] }) {
  const [selectedShellId, setSelectedShellId] = useState(cellData?.shellId || null);
  const [selectedShellNumber, setSelectedShellNumber] = useState(cellData?.shellNumber || null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedColor, setSelectedColor] = useState(null);
  const [filterShellPackId, setFilterShellPackId] = useState('');

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

  // Count shell usage across all racks in the show
  const shellUsageCounts = useMemo(() => {
    const counts = new Map(); // Map of "shellId_shellNumber" -> count
    
    showItems.forEach(item => {
      if (item.type === 'RACK_SHELLS' && item.fireableItem && item.fireableItem.cellData) {
        // Handle both single object and array cases
        let cellDataArray = [];
        if (Array.isArray(item.fireableItem.cellData)) {
          cellDataArray = item.fireableItem.cellData;
        } else if (item.fireableItem.cellData && typeof item.fireableItem.cellData === 'object') {
          // Single cellData object - wrap it in an array
          cellDataArray = [item.fireableItem.cellData];
        }
        
        cellDataArray.forEach(cellData => {
          if (cellData && cellData.shellId !== null && cellData.shellId !== undefined) {
            // Create key: shellId_shellNumber (or shellId_null for "ANY")
            const key = `${cellData.shellId}_${cellData.shellNumber || 'null'}`;
            counts.set(key, (counts.get(key) || 0) + 1);
          }
        });
      }
    });
    
    return counts;
  }, [showItems]);

  // Get usage count for a specific shell
  const getShellUsageCount = (shellId, shellNumber) => {
    const key = `${shellId}_${shellNumber || 'null'}`;
    return shellUsageCounts.get(key) || 0;
  };

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

  const handleSelect = () => {
    onSelect(selectedShellId, selectedShellNumber);
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-gray-800 text-white p-6 rounded shadow-lg w-[900px] max-h-[80vh] overflow-hidden relative z-50 flex flex-col">
        <h2 className="text-xl mb-4">{isBatch ? 'Batch Assign Shell' : 'Select Shell'}</h2>
        
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
          <div className="overflow-y-auto border-r border-gray-700 pr-4">
            <div className="space-y-2">
              {displayShells.length > 0 ? (
                displayShells.map((result, idx) => {
                  const isSelected = result.item.id === selectedShellId && 
                    (result.shell === null ? selectedShellNumber === null : result.shell?.number === selectedShellNumber);
                  
                  return (
                    <div
                      key={`${result.item.id}_${result.shell?.number || 'any'}_${idx}`}
                      onClick={() => {
                        setSelectedShellId(result.item.id);
                        setSelectedShellNumber(result.shell?.number || null);
                      }}
                      className={`p-3 rounded cursor-pointer flex items-center justify-between ${
                        isSelected
                          ? 'bg-blue-600'
                          : 'bg-gray-700 hover:bg-gray-600'
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold truncate flex items-center gap-2">
                          {result.item.name}
                          {(() => {
                            const usageCount = getShellUsageCount(result.item.id, result.shell?.number || null);
                            if (usageCount > 0) {
                              return (
                                <span className="text-xs bg-blue-500 text-white px-2 py-0.5 rounded">
                                  Used {usageCount}x
                                </span>
                              );
                            }
                            return null;
                          })()}
                        </div>
                        {result.shell ? (
                          <>
                            <div className="text-sm text-gray-300">
                              Shell #{result.shell.number}
                              {result.shell.description && ` - ${result.shell.description}`}
                            </div>
                            {result.shell.effects && result.shell.effects.length > 0 && (
                              <div className="text-xs text-gray-400 mt-1">
                                {result.shell.effects.join(', ')}
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="text-sm text-gray-300">ANY shell</div>
                        )}
                      </div>
                      <div className="flex gap-1 ml-2 flex-shrink-0">
                        {result.shell?.colors && result.shell.colors.length > 0 ? (
                          result.shell.colors.map((color, colorIdx) => (
                            <div
                              key={colorIdx}
                              className="w-6 h-6 rounded border border-gray-600"
                              style={{ backgroundColor: color }}
                              title={color}
                            />
                          ))
                        ) : result.shell === null ? (
                          <div className="text-xs text-gray-500">-</div>
                        ) : (
                          <div className="text-xs text-gray-500">No colors</div>
                        )}
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="text-center text-gray-400 py-8">
                  No shells found matching your filters
                </div>
              )}
            </div>
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

            {/* Action Buttons */}
            <div className="flex gap-2 mt-auto pt-4 border-t border-gray-700">
              <button
                onClick={handleSelect}
                disabled={!selectedShellId}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed"
              >
                {isBatch ? 'Assign to Selected Cells' : 'Select'}
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

