import React, { useState } from 'react';

export default function FuseModal({ isOpen, onClose, onConfirm, inventory }) {
  const [fuseType, setFuseType] = useState('');
  const [leadIn, setLeadIn] = useState(1);

  const fuseInventory = inventory.filter(item => item.type === 'FUSE');

  const handleConfirm = () => {
    if (!fuseType) {
      alert('Please select a fuse type');
      return;
    }
    onConfirm(fuseType, leadIn);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-gray-800 text-white p-6 rounded shadow-lg w-96 relative z-50">
        <h2 className="text-xl mb-4">Create Fuse</h2>
        
        <div className="mb-4">
          <label className="block mb-2">Select Fuse Type:</label>
          <select
            className="w-full p-2 bg-gray-700 rounded"
            value={fuseType}
            onChange={(e) => setFuseType(e.target.value)}
          >
            <option value="" disabled>-- Select Fuse Type --</option>
            {fuseInventory.map((fuse) => (
              <option key={fuse.id} value={fuse.id}>
                <span style={{ color: fuse.color }}>{fuse.name}</span> ({fuse.burn_rate} s/f)
              </option>
            ))}
          </select>
        </div>

        <div className="mb-4">
          <label className="block mb-2">Lead-In (inches):</label>
          <input
            type="number"
            min="0"
            step="0.1"
            value={leadIn}
            onChange={(e) => setLeadIn(parseFloat(e.target.value) || 0)}
            className="w-full p-2 bg-gray-700 rounded"
          />
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleConfirm}
            className="flex-1 px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
          >
            Create Fuse
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

