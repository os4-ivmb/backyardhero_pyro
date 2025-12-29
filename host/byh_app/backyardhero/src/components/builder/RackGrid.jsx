import React, { useState, useRef, useEffect } from 'react';
import CellShellSelector from './CellShellSelector';
import FuseModal from './FuseModal';

export default function RackGrid({ rack, inventory, onUpdate }) {
  // Filter inventory for shells and fuses
  const aerialShells = inventory.filter(item => item.type === 'AERIAL_SHELL');
  const [selectedCells, setSelectedCells] = useState(new Set());
  const [clickedCell, setClickedCell] = useState(null);
  const [showShellSelector, setShowShellSelector] = useState(false);
  const [showFuseModal, setShowFuseModal] = useState(false);
  const [showBatchModal, setShowBatchModal] = useState(false);
  const gridRef = useRef(null);

  const cells = rack.cells || {};
  const fuses = rack.fuses || {};

  // Get cell key from x, y
  const getCellKey = (x, y) => `${x}_${y}`;

  // Check if cell is selected
  const isCellSelected = (x, y) => {
    return selectedCells.has(getCellKey(x, y));
  };

  // Check if cell has a shell
  const cellHasShell = (x, y) => {
    const key = getCellKey(x, y);
    return cells[key] && cells[key].shellId !== null;
  };

  // Get cell data
  const getCellData = (x, y) => {
    const key = getCellKey(x, y);
    return cells[key] || null;
  };

  // Check if cell is part of a fuse
  const getCellFuse = (x, y) => {
    const key = getCellKey(x, y);
    const cellData = cells[key];
    if (!cellData || !cellData.fuseId) return null;
    return fuses[cellData.fuseId] || null;
  };

  // Check if two cells are adjacent
  const areAdjacent = (x1, y1, x2, y2) => {
    return (Math.abs(x1 - x2) === 1 && y1 === y2) || (Math.abs(y1 - y2) === 1 && x1 === x2);
  };

  // Handle cell click
  const handleCellClick = (e, x, y) => {
    const key = getCellKey(x, y);
    
    if (e.ctrlKey || e.metaKey) {
      // Multi-select mode
      setSelectedCells(prev => {
        const newSet = new Set(prev);
        if (newSet.has(key)) {
          newSet.delete(key);
        } else {
          // Only allow selecting if it's the first cell or adjacent to at least one selected cell
          if (newSet.size === 0) {
            newSet.add(key);
          } else {
            // Check if this cell is adjacent to any selected cell
            let isAdjacentToAny = false;
            for (const selectedKey of newSet) {
              const [sx, sy] = selectedKey.split('_').map(Number);
              if (areAdjacent(x, y, sx, sy)) {
                isAdjacentToAny = true;
                break;
              }
            }
            if (isAdjacentToAny) {
              newSet.add(key);
            }
          }
        }
        return newSet;
      });
    } else {
      // Single click - show shell selector
      setSelectedCells(new Set([key]));
      setClickedCell({ x, y });
      setShowShellSelector(true);
    }
  };

  // Handle shell selection
  const handleShellSelected = (shellId, shellNumber) => {
    if (!clickedCell) return;
    
    const key = getCellKey(clickedCell.x, clickedCell.y);
    const updatedCells = { ...cells };
    
    if (shellId === null) {
      // Remove shell
      delete updatedCells[key];
    } else {
      // Set shell
      updatedCells[key] = {
        shellId,
        shellNumber: shellNumber || null,
        fuseId: cells[key]?.fuseId || null // Preserve fuse if exists
      };
    }
    
    onUpdate({ ...rack, cells: updatedCells });
    setShowShellSelector(false);
    setClickedCell(null);
    setSelectedCells(new Set());
  };

  // Handle batch assignment
  const handleBatchAssign = (shellId, shellNumber) => {
    const updatedCells = { ...cells };
    
    for (const key of selectedCells) {
      updatedCells[key] = {
        shellId,
        shellNumber: shellNumber || null,
        fuseId: cells[key]?.fuseId || null // Preserve fuse if exists
      };
    }
    
    onUpdate({ ...rack, cells: updatedCells });
    setShowBatchModal(false);
    setSelectedCells(new Set());
  };

  // Handle fuse creation
  const handleFuseCreate = (fuseType, leadIn) => {
    if (selectedCells.size < 2) return;
    
    // Create fuse ID
    const fuseId = `fuse_${Date.now()}`;
    
    // Sort cells by position (top to bottom, left to right)
    const sortedCells = Array.from(selectedCells).sort((a, b) => {
      const [ax, ay] = a.split('_').map(Number);
      const [bx, by] = b.split('_').map(Number);
      if (ay !== by) return ay - by;
      return ax - bx;
    });
    
    // Update cells with fuse ID
    const updatedCells = { ...cells };
    for (const key of sortedCells) {
      if (updatedCells[key]) {
        updatedCells[key].fuseId = fuseId;
      } else {
        updatedCells[key] = {
          shellId: null,
          shellNumber: null,
          fuseId: fuseId
        };
      }
    }
    
    // Create fuse entry
    const updatedFuses = {
      ...fuses,
      [fuseId]: {
        type: fuseType,
        leadIn: leadIn,
        cells: sortedCells
      }
    };
    
    onUpdate({ ...rack, cells: updatedCells, fuses: updatedFuses });
    setShowFuseModal(false);
    setSelectedCells(new Set());
  };

  // Get shell data from inventory
  const getShellData = (shellId) => {
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
    const lines = [];
    
    for (const [fuseId, fuse] of Object.entries(fuses)) {
      if (fuse.cells.length < 2) continue;
      
      // Get fuse color from inventory
      // fuse.type is the fuse ID (integer), so we need to compare with parseInt
      const fuseItem = inventory.find(item => item.type === 'FUSE' && item.id === parseInt(fuse.type));
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

  return (
    <div className="relative">
      <div className="mb-4">
        <div className="text-sm text-gray-400">
          Grid: {rack.x_rows} x {rack.y_rows} | Spacing: {rack.x_spacing}" x {rack.y_spacing}"
        </div>
        {selectedCells.size > 1 && (
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => setShowBatchModal(true)}
              className="px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
            >
              Batch
            </button>
            <button
              onClick={() => setShowFuseModal(true)}
              className="px-3 py-1 bg-green-600 text-white rounded hover:bg-green-700 text-sm"
            >
              Fuse
            </button>
          </div>
        )}
      </div>

      <div className="relative inline-block">
        <div
          ref={gridRef}
          className="grid gap-1 relative"
          style={{
            gridTemplateColumns: `repeat(${rack.x_rows}, minmax(0, 1fr))`,
            width: `${rack.x_rows * 60}px`
          }}
        >
          <svg
            className="absolute inset-0 pointer-events-none z-10"
            style={{ 
              width: `${rack.x_rows * 60}px`, 
              height: `${rack.y_rows * 60}px` 
            }}
          >
            {renderFuseLines()}
          </svg>
          {Array.from({ length: rack.y_rows }).map((_, y) =>
            Array.from({ length: rack.x_rows }).map((_, x) => {
              const key = getCellKey(x, y);
              const cellData = getCellData(x, y);
              const shell = cellData ? getShellData(cellData.shellId) : null;
              const colors = cellData ? getShellColors(cellData.shellId, cellData.shellNumber) : [];
              const isSelected = isCellSelected(x, y);
              const hasShell = cellHasShell(x, y);
              
                  return (
                <div
                  key={key}
                  onClick={(e) => handleCellClick(e, x, y)}
                  className={`
                    relative w-14 h-14 border-2 rounded cursor-pointer
                    ${isSelected ? 'border-blue-500 bg-blue-900 bg-opacity-30' : 'border-gray-600'}
                    ${hasShell ? 'bg-gray-600' : 'bg-gray-800'}
                    hover:border-gray-400
                  `}
                  title={shell ? `${shell.name}${cellData.shellNumber ? ` #${cellData.shellNumber}` : ''}` : 'Empty'}
                >
                  {hasShell && (
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

      {showShellSelector && clickedCell && (
        <CellShellSelector
          isOpen={showShellSelector}
          onClose={() => {
            setShowShellSelector(false);
            setClickedCell(null);
          }}
          onSelect={handleShellSelected}
          cellData={getCellData(clickedCell.x, clickedCell.y)}
          inventory={inventory}
        />
      )}

      {showBatchModal && (
        <CellShellSelector
          isOpen={showBatchModal}
          onClose={() => setShowBatchModal(false)}
          onSelect={handleBatchAssign}
          cellData={null}
          inventory={inventory}
          isBatch={true}
        />
      )}

      {showFuseModal && (
        <FuseModal
          isOpen={showFuseModal}
          onClose={() => setShowFuseModal(false)}
          onConfirm={handleFuseCreate}
          inventory={inventory}
        />
      )}
    </div>
  );
}

