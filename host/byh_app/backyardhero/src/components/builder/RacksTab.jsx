import React, { useState, useEffect } from 'react';
import axios from 'axios';
import RackGrid from './RackGrid';

export default function RacksTab({ inventory, showId, showItems = [] }) {
  const [racks, setRacks] = useState([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingRackId, setEditingRackId] = useState(null);
  const [editingRackName, setEditingRackName] = useState('');
  const [newRack, setNewRack] = useState({
    name: '',
    x_rows: 4,
    x_spacing: 2.75,
    y_rows: 4,
    y_spacing: 2.75
  });

  useEffect(() => {
    if (showId) {
      fetchRacks();
    }
  }, [showId]);

  const fetchRacks = async () => {
    if (!showId) return;
    try {
      const response = await axios.get('/api/racks', { params: { show_id: showId } });
      setRacks(response.data);
    } catch (error) {
      console.error('Failed to fetch racks:', error);
    }
  };

  const handleAddRack = async () => {
    if (!newRack.name) {
      alert('Please enter a rack name');
      return;
    }

    if (!showId) {
      alert('Please save the show first before adding racks');
      return;
    }

    try {
      const response = await axios.post('/api/racks', {
        show_id: showId,
        ...newRack,
        cells: {},
        fuses: {}
      });
      await fetchRacks();
      setNewRack({ name: '', x_rows: 4, x_spacing: 2.75, y_rows: 4, y_spacing: 2.75 });
      setShowAddForm(false);
    } catch (error) {
      console.error('Failed to create rack:', error);
      alert('Failed to create rack');
    }
  };

  const handleUpdateRack = async (rackId, updatedRack) => {
    try {
      await axios.patch(`/api/racks/${rackId}`, updatedRack);
      await fetchRacks();
    } catch (error) {
      console.error('Failed to update rack:', error);
      alert('Failed to update rack');
    }
  };

  const handleDeleteRack = async (rackId) => {
    if (!confirm('Are you sure you want to delete this rack?')) {
      return;
    }

    try {
      await axios.delete(`/api/racks/${rackId}`);
      await fetchRacks();
    } catch (error) {
      console.error('Failed to delete rack:', error);
      alert('Failed to delete rack');
    }
  };

  const handleCloneRack = async (rackId) => {
    if (!showId) {
      alert('Please save the show first before cloning racks');
      return;
    }

    const rackToClone = racks.find(r => r.id === rackId);
    if (!rackToClone) {
      alert('Rack not found');
      return;
    }

    try {
      await axios.post('/api/racks', {
        show_id: showId,
        name: `${rackToClone.name} (Copy)`,
        x_rows: rackToClone.x_rows,
        x_spacing: rackToClone.x_spacing,
        y_rows: rackToClone.y_rows,
        y_spacing: rackToClone.y_spacing,
        cells: rackToClone.cells,
        fuses: rackToClone.fuses
      });
      await fetchRacks();
    } catch (error) {
      console.error('Failed to clone rack:', error);
      alert('Failed to clone rack');
    }
  };

  const handleStartEditName = (rack) => {
    setEditingRackId(rack.id);
    setEditingRackName(rack.name);
  };

  const handleSaveName = async (rackId) => {
    if (!editingRackName.trim()) {
      alert('Rack name cannot be empty');
      return;
    }

    const rack = racks.find(r => r.id === rackId);
    if (!rack) return;

    try {
      await axios.patch(`/api/racks/${rackId}`, {
        ...rack,
        name: editingRackName.trim()
      });
      setEditingRackId(null);
      setEditingRackName('');
      await fetchRacks();
    } catch (error) {
      console.error('Failed to update rack name:', error);
      alert('Failed to update rack name');
    }
  };

  const handleCancelEditName = () => {
    setEditingRackId(null);
    setEditingRackName('');
  };

  const aerialShells = inventory.filter(item => item.type === 'AERIAL_SHELL');

  return (
    <div className="p-4 bg-gray-800 rounded-lg">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold text-white">Racks</h3>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          {showAddForm ? 'Cancel' : 'Add Rack'}
        </button>
      </div>

      {showAddForm && (
        <div className="mb-6 p-4 bg-gray-700 rounded-lg">
          <h4 className="text-md font-semibold text-white mb-3">Add New Rack</h4>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-300 mb-1">Rack Name</label>
              <input
                type="text"
                value={newRack.name}
                onChange={(e) => setNewRack({ ...newRack, name: e.target.value })}
                className="w-full p-2 bg-gray-600 text-white rounded"
                placeholder="Enter rack name"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-300 mb-1">X Rows (Columns)</label>
              <input
                type="number"
                min="1"
                value={newRack.x_rows}
                onChange={(e) => setNewRack({ ...newRack, x_rows: parseInt(e.target.value) || 1 })}
                className="w-full p-2 bg-gray-600 text-white rounded"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-300 mb-1">X Spacing (inches)</label>
              <input
                type="number"
                min="0"
                step="0.1"
                value={newRack.x_spacing}
                onChange={(e) => setNewRack({ ...newRack, x_spacing: parseFloat(e.target.value) || 0 })}
                className="w-full p-2 bg-gray-600 text-white rounded"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-300 mb-1">Y Rows</label>
              <input
                type="number"
                min="1"
                value={newRack.y_rows}
                onChange={(e) => setNewRack({ ...newRack, y_rows: parseInt(e.target.value) || 1 })}
                className="w-full p-2 bg-gray-600 text-white rounded"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-300 mb-1">Y Spacing (inches)</label>
              <input
                type="number"
                min="0"
                step="0.1"
                value={newRack.y_spacing}
                onChange={(e) => setNewRack({ ...newRack, y_spacing: parseFloat(e.target.value) || 0 })}
                className="w-full p-2 bg-gray-600 text-white rounded"
              />
            </div>
          </div>
          <button
            onClick={handleAddRack}
            className="mt-4 px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
          >
            Create Rack
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-6">
        {racks.map(rack => (
          <div key={rack.id} className="bg-gray-700 rounded-lg p-4">
            <div className="flex justify-between items-center mb-3">
              {editingRackId === rack.id ? (
                <div className="flex items-center gap-2 flex-1">
                  <input
                    type="text"
                    value={editingRackName}
                    onChange={(e) => setEditingRackName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        handleSaveName(rack.id);
                      } else if (e.key === 'Escape') {
                        handleCancelEditName();
                      }
                    }}
                    className="flex-1 p-2 bg-gray-600 text-white rounded text-md font-semibold"
                    autoFocus
                  />
                  <button
                    onClick={() => handleSaveName(rack.id)}
                    className="px-3 py-1 bg-green-600 text-white rounded hover:bg-green-700 text-sm"
                  >
                    Save
                  </button>
                  <button
                    onClick={handleCancelEditName}
                    className="px-3 py-1 bg-gray-600 text-white rounded hover:bg-gray-700 text-sm"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <h4 
                    className="text-md font-semibold text-white cursor-pointer hover:text-blue-400"
                    onClick={() => handleStartEditName(rack)}
                    title="Click to edit name"
                  >
                    {rack.name}
                  </h4>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleCloneRack(rack.id)}
                      className="px-3 py-1 bg-green-600 text-white rounded hover:bg-green-700 text-sm"
                    >
                      Clone
                    </button>
                    <button
                      onClick={() => handleDeleteRack(rack.id)}
                      className="px-3 py-1 bg-red-600 text-white rounded hover:bg-red-700 text-sm"
                    >
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>
            <RackGrid
              rack={rack}
              inventory={inventory}
              onUpdate={(updatedRack) => handleUpdateRack(rack.id, updatedRack)}
              showItems={showItems}
            />
          </div>
        ))}
      </div>

      {!showId && (
        <div className="text-center text-gray-400 py-8">
          Please save the show first before adding racks.
        </div>
      )}

      {showId && racks.length === 0 && !showAddForm && (
        <div className="text-center text-gray-400 py-8">
          No racks yet. Click "Add Rack" to create one.
        </div>
      )}
    </div>
  );
}

