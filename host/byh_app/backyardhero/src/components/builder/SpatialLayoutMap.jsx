import React, { useRef, useState } from 'react';
import { MdSave } from 'react-icons/md';

const SpatialLayoutMap = ({ 
  receivers, 
  items, 
  receiverLocations, 
  setReceiverLocations, 
  onSaveLocations,
  showSaveButton = true 
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [draggedReceiver, setDraggedReceiver] = useState(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const mapRef = useRef(null);

  // Handle mouse down on receiver circle
  const handleMouseDown = (e, receiverKey) => {
    e.preventDefault();
    setIsDragging(true);
    setDraggedReceiver(receiverKey);
    
    const rect = mapRef.current.getBoundingClientRect();
    const currentPos = receiverLocations[receiverKey] || { x: 0, y: 0 };
    setDragOffset({
      x: e.clientX - rect.left - currentPos.x,
      y: e.clientY - rect.top - currentPos.y
    });
  };

  // Handle mouse move
  const handleMouseMove = (e) => {
    if (!isDragging || !draggedReceiver || !mapRef.current) return;

    const rect = mapRef.current.getBoundingClientRect();
    const newX = e.clientX - rect.left - dragOffset.x;
    const newY = e.clientY - rect.top - dragOffset.y;

    // Constrain to map bounds (64px for 16x16 circles)
    const constrainedX = Math.max(0, Math.min(newX, rect.width - 64));
    const constrainedY = Math.max(0, Math.min(newY, rect.height - 64));

    setReceiverLocations(prev => ({
      ...prev,
      [draggedReceiver]: { x: constrainedX, y: constrainedY }
    }));
  };

  // Handle mouse up
  const handleMouseUp = () => {
    setIsDragging(false);
    setDraggedReceiver(null);
  };

  // Filter receivers to only show those with assigned items
  const activeReceivers = Object.keys(receivers || {}).filter(receiverKey => {
    const itemCount = items.filter(item => {
      const receiver = receivers[receiverKey];
      if (!receiver || !receiver.cues) return false;
      
      return Object.entries(receiver.cues).some(([zone, targets]) => 
        item.zone === zone && targets.includes(item.target)
      );
    }).length;
    
    return itemCount > 0;
  });

  if (activeReceivers.length === 0) {
    return (
      <div className="mt-8">
        <h2 className="text-2xl font-bold mb-4">Receiver Layout</h2>
        <div className="bg-gray-800 rounded-lg p-8 text-center">
          <p className="text-gray-600">No receivers with assigned items to display</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-8 bg-gray-800 ">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-2xl font-bold">Receiver Layout</h2>
        {showSaveButton && onSaveLocations && (
          <button
            onClick={onSaveLocations}
            className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors print:hidden"
          >
            <MdSave />
            Save Layout
          </button>
        )}
      </div>
      
      <div className="bg-gray-800 rounded-lg p-4">
        <div 
          ref={mapRef}
          className="relative w-full h-96 rounded-lg overflow-hidden cursor-crosshair"
          style={{
            background: `
              linear-gradient(45deg, #1a5f1a 25%, transparent 25%), 
              linear-gradient(-45deg, #1a5f1a 25%, transparent 25%), 
              linear-gradient(45deg, transparent 75%, #1a5f1a 75%), 
              linear-gradient(-45deg, transparent 75%, #1a5f1a 75%),
              linear-gradient(to bottom, #0d4f14, #1a5f1a, #2d7a2d)
            `,
            backgroundSize: '20px 20px, 20px 20px, 20px 20px, 20px 20px, 100% 100%',
            backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px, 0 0'
          }}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          {/* Satellite map overlay effect */}
          <div className="absolute inset-0 bg-gradient-to-br from-transparent via-transparent to-black opacity-30"></div>
          
          {/* Additional satellite-like details */}
          <div className="absolute inset-0 opacity-20">
            <div className="w-full h-full" style={{
              backgroundImage: `
                radial-gradient(circle at 20% 30%, rgba(255,255,255,0.1) 1px, transparent 1px),
                radial-gradient(circle at 80% 70%, rgba(255,255,255,0.1) 1px, transparent 1px),
                radial-gradient(circle at 40% 60%, rgba(255,255,255,0.1) 1px, transparent 1px),
                radial-gradient(circle at 60% 20%, rgba(255,255,255,0.1) 1px, transparent 1px)
              `,
              backgroundSize: '100px 100px, 150px 150px, 120px 120px, 80px 80px'
            }}></div>
          </div>
          
          {/* Receiver circles */}
          {activeReceivers.map((receiverKey) => {
            const itemCount = items.filter(item => {
              const receiver = receivers[receiverKey];
              if (!receiver || !receiver.cues) return false;
              
              return Object.entries(receiver.cues).some(([zone, targets]) => 
                item.zone === zone && targets.includes(item.target)
              );
            }).length;
            
            const location = receiverLocations[receiverKey] || { x: 0, y: 0 };
            
            return (
              <div
                key={receiverKey}
                className={`absolute w-16 h-16 rounded-full border-2 border-white shadow-lg cursor-move transition-all duration-200 ${
                  isDragging && draggedReceiver === receiverKey 
                    ? 'scale-110 z-50' 
                    : 'hover:scale-105 z-10'
                }`}
                style={{
                  left: location.x || 0,
                  top: location.y || 0,
                  backgroundColor: '#3b82f6',
                  transform: isDragging && draggedReceiver === receiverKey ? 'scale(1.1)' : 'scale(1)'
                }}
                onMouseDown={(e) => handleMouseDown(e, receiverKey)}
              >
                <div className="flex items-center justify-center h-full text-white text-xs font-bold">
                  {receiverKey}
                </div>
                {/* Item count indicator */}
                <div className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full w-6 h-6 flex items-center justify-center">
                  {itemCount}
                </div>
              </div>
            );
          })}
          
          {/* Grid lines overlay */}
          <div className="absolute inset-0 pointer-events-none">
            <div className="w-full h-full" style={{
              backgroundImage: `
                linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px),
                linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px),
                linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
                linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)
              `,
              backgroundSize: '50px 50px, 50px 50px, 10px 10px, 10px 10px'
            }}></div>
          </div>
          
          {/* Satellite view indicators */}
          <div className="absolute top-2 left-2 text-white text-xs opacity-60">
            <div className="bg-black bg-opacity-50 px-2 py-1 rounded">
              Satellite View
            </div>
          </div>
          
          {/* Scale indicator */}
          <div className="absolute bottom-2 right-2 text-white text-xs opacity-60">
            <div className="bg-black bg-opacity-50 px-2 py-1 rounded">
              Scale: 1:100
            </div>
          </div>
        </div>
        
        <div className="mt-4 text-sm text-gray-600">
          <p>• Drag receivers to position them on the map</p>
          <p>• Only receivers with assigned items are shown</p>
          <p>• Numbers show how many items are assigned to each receiver</p>
          {showSaveButton && <p>• Click "Save Layout" to persist the positions</p>}
        </div>
      </div>
    </div>
  );
};

export default SpatialLayoutMap; 