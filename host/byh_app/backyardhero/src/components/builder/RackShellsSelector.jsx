import React, { useState, useEffect } from 'react';
import axios from 'axios';

export default function RackShellsSelector({ onSelect, onClose, items, inventory, showId }) {
  const [racks, setRacks] = useState([]);
  const [selectedRackId, setSelectedRackId] = useState(null);
  const [selectedRack, setSelectedRack] = useState(null);
  const [fireableItems, setFireableItems] = useState([]);
  const [selectedItem, setSelectedItem] = useState(null);
  const [usedCells, setUsedCells] = useState(new Set());

  useEffect(() => {
    if (showId) {
      fetchRacks();
    }
    // Extract used cells from existing items
    const used = new Set();
    items.forEach(item => {
      if (item.type === 'RACK_SHELLS' && item.rackCells) {
        item.rackCells.forEach(cell => used.add(cell));
      }
    });
    setUsedCells(used);
  }, [items, showId]);

  const fetchRacks = async () => {
    if (!showId) return;
    try {
      const response = await axios.get('/api/racks', { params: { show_id: showId } });
      setRacks(response.data);
    } catch (error) {
      console.error('Failed to fetch racks:', error);
    }
  };

  useEffect(() => {
    if (selectedRackId) {
      const rack = racks.find(r => r.id === selectedRackId);
      setSelectedRack(rack);
      if (rack) {
        calculateFireableItems(rack);
      }
    }
  }, [selectedRackId, racks, usedCells]);

  const calculateFireableItems = (rack) => {
    const cells = rack.cells || {};
    const fuses = rack.fuses || {};
    const items = [];
    const processedCells = new Set();

    // Find all single cells with shells that aren't part of a fuse
    for (const [cellKey, cellData] of Object.entries(cells)) {
      if (cellData.shellId && !cellData.fuseId && !usedCells.has(cellKey)) {
        items.push({
          type: 'single',
          cells: [cellKey],
          cellData: cellData
        });
        processedCells.add(cellKey);
      }
    }

    // Find all fused links
    for (const [fuseId, fuse] of Object.entries(fuses)) {
      if (fuse.cells && fuse.cells.length >= 2) {
        // Check if all cells in this fuse have shells and aren't used
        const allHaveShells = fuse.cells.every(cellKey => {
          const cellData = cells[cellKey];
          return cellData && cellData.shellId;
        });
        const noneUsed = fuse.cells.every(cellKey => !usedCells.has(cellKey));
        
        if (allHaveShells && noneUsed) {
          items.push({
            type: 'fused',
            fuseId: fuseId,
            fuse: fuse,
            cells: fuse.cells,
            cellData: fuse.cells.map(cellKey => cells[cellKey])
          });
          fuse.cells.forEach(cellKey => processedCells.add(cellKey));
        }
      }
    }

    setFireableItems(items);
  };

  const getCellKey = (x, y) => `${x}_${y}`;
  const isCellUsed = (x, y) => {
    return usedCells.has(getCellKey(x, y));
  };

  // Get shell data from inventory
  const getShellData = (shellId) => {
    if (!inventory) return null;
    const aerialShells = inventory.filter(item => item.type === 'AERIAL_SHELL');
    return aerialShells.find(item => item.id === shellId);
  };

  // Get shell colors
  const getShellColors = (shellId, shellNumber) => {
    const shell = getShellData(shellId);
    if (!shell || !shell.metadata) return [];
    
    try {
      const metadata = typeof shell.metadata === 'string' ? JSON.parse(shell.metadata) : shell.metadata;
      const packData = metadata?.pack_shell_data;
      if (!packData || !packData.shells) return [];
      
      const shellData = packData.shells.find(s => s.number === shellNumber);
      return shellData?.colors || [];
    } catch (e) {
      return [];
    }
  };

  // Calculate cell position for fuse line drawing
  const getCellCenter = (x, y) => {
    const cellSize = 56; // w-14 = 56px (3.5rem)
    const gap = 4; // gap-1 = 4px (0.25rem)
    const xPos = x * (cellSize + gap) + cellSize / 2;
    const yPos = y * (cellSize + gap) + cellSize / 2;
    return { x: xPos, y: yPos };
  };

  // Render fuse lines
  const renderFuseLines = () => {
    if (!selectedRack) return null;
    const fuses = selectedRack.fuses || {};
    const lines = [];
    
    for (const [fuseId, fuse] of Object.entries(fuses)) {
      if (fuse.cells.length < 2) continue;
      
      // Get fuse color from inventory
      const fuseItem = inventory?.find(item => item.type === 'FUSE' && item.id === parseInt(fuse.type));
      const fuseColor = fuseItem?.color || '#FFD700';
      
      // Draw line connecting all cells
      for (let i = 0; i < fuse.cells.length - 1; i++) {
        const [x1, y1] = fuse.cells[i].split('_').map(Number);
        const [x2, y2] = fuse.cells[i + 1].split('_').map(Number);
        const start = getCellCenter(x1, y1);
        const end = getCellCenter(x2, y2);
        
        lines.push(
          <line
            key={`${fuseId}_${i}`}
            x1={start.x}
            y1={start.y}
            x2={end.x}
            y2={end.y}
            stroke={fuseColor}
            strokeWidth="4"
            strokeLinecap="round"
          />
        );
      }
    }
    
    return lines;
  };

  const handleSelect = () => {
    if (selectedItem) {
      // Generate a unique ID for this fireable item
      const fireableItemId = `rack_${selectedRackId}_${selectedItem.type}_${Date.now()}`;
      
      onSelect({
        type: 'RACK_SHELLS',
        rackId: selectedRackId,
        rackName: selectedRack.name,
        fireableItem: selectedItem,
        fireableItemId: fireableItemId,
        rackCells: selectedItem.cells,
        rackSpacing: {
          x: selectedRack.x_spacing,
          y: selectedRack.y_spacing
        }
      });
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="block mb-2">Select Rack:</label>
        <select
          className="w-full p-2 bg-gray-700 rounded"
          value={selectedRackId || ''}
          onChange={(e) => {
            setSelectedRackId(e.target.value ? parseInt(e.target.value) : null);
            setSelectedItem(null);
          }}
        >
          <option value="">-- Select Rack --</option>
          {racks.map(rack => (
            <option key={rack.id} value={rack.id}>
              {rack.name}
            </option>
          ))}
        </select>
      </div>

      {selectedRack && (
        <div>
          <label className="block mb-2">Select Fireable Item:</label>
          <div className="mb-4 p-3 bg-gray-700 rounded max-h-96 overflow-y-auto">
            <div className="text-sm text-gray-400 mb-2">
              Grid: {selectedRack.x_rows} x {selectedRack.y_rows}
            </div>
            <div className="relative inline-block">
              <div className="grid gap-1 relative" style={{ gridTemplateColumns: `repeat(${selectedRack.x_rows}, minmax(0, 1fr))`, width: `${selectedRack.x_rows * 60}px` }}>
                <svg
                  className="absolute inset-0 pointer-events-none z-10"
                  style={{ 
                    width: `${selectedRack.x_rows * 60}px`, 
                    height: `${selectedRack.y_rows * 60}px` 
                  }}
                >
                  {renderFuseLines()}
                </svg>
                {Array.from({ length: selectedRack.y_rows }).map((_, y) =>
                  Array.from({ length: selectedRack.x_rows }).map((_, x) => {
                    const key = getCellKey(x, y);
                    const cellData = selectedRack.cells?.[key];
                    const isUsed = isCellUsed(x, y);
                    const isSelected = selectedItem && selectedItem.cells.includes(key);
                    const hasShell = cellData && cellData.shellId;
                    const shell = cellData ? getShellData(cellData.shellId) : null;
                    const colors = cellData ? getShellColors(cellData.shellId, cellData.shellNumber) : [];
                    
                    return (
                      <div
                        key={key}
                        onClick={() => {
                          const item = fireableItems.find(item => item.cells.includes(key));
                          if (item && !isUsed) {
                            setSelectedItem(item);
                          }
                        }}
                        className={`
                          relative w-14 h-14 border-2 rounded cursor-pointer
                          ${isUsed ? 'bg-gray-900 border-gray-800 opacity-50 cursor-not-allowed' : ''}
                          ${isSelected ? 'border-blue-500 bg-blue-900 bg-opacity-30' : 'border-gray-600'}
                          ${hasShell && !isUsed ? 'bg-gray-600' : 'bg-gray-800'}
                          ${!isUsed ? 'hover:border-gray-400' : ''}
                        `}
                        title={isUsed ? 'Already used' : shell ? `${shell.name}${cellData.shellNumber ? ` #${cellData.shellNumber}` : ''}` : 'Empty'}
                      >
                        {hasShell && !isUsed && shell && (
                          <>
                            <div className="absolute inset-0 flex flex-col items-center justify-center text-xs text-white px-1">
                              <div className="text-[10px] leading-tight font-semibold">
                                {shell.name.substring(0, 7).toUpperCase()}
                              </div>
                              <div className="text-[10px] leading-tight">
                                {cellData.shellNumber ? `#${cellData.shellNumber}` : 'ANY'}
                              </div>
                            </div>
                            {colors.length > 0 && (
                              <div className="absolute bottom-0 left-0 right-0 h-2 flex">
                                {colors.map((color, idx) => (
                                  <div
                                    key={idx}
                                    className="flex-1"
                                    style={{ backgroundColor: color }}
                                  />
                                ))}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          {fireableItems.length === 0 && (
            <div className="text-gray-400 text-sm mb-2">
              No fireable items available (all cells are used or don't have shells)
            </div>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={handleSelect}
          disabled={!selectedItem}
          className="flex-1 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed"
        >
          Select
        </button>
        <button
          onClick={onClose}
          className="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

