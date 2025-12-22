import React, { useState, useEffect } from "react";

const FusedLineBuilderModal = ({ isOpen, onClose, onAdd, inventory }) => {
  const [fuseType, setFuseType] = useState("");
  const [shellCount, setShellCount] = useState(1);
  const [spacing, setSpacing] = useState(2.75);
  const [leadInInches, setLeadInInches] = useState(1);
  const [shellSlots, setShellSlots] = useState([]);

  // Filter inventory for FUSE and AERIAL_SHELL types
  const fuseInventory = inventory.filter((item) => item.type === "FUSE");
  const shellInventory = inventory.filter((item) => item.type === "AERIAL_SHELL");


  // Update the shell slots whenever the shell count changes
  useEffect(() => {
    setShellSlots(Array.from({ length: shellCount }, () => null));
  }, [shellCount]);

  const handleAssignShell = (index, shell) => {
    console.log(`${index} ${shell}`)
    setShellSlots((prevSlots) =>
      prevSlots.map((slot, i) => (i === index ? shell : slot))
    );
  };

  const handleAssignShellToAll = (shell) => {
    setShellSlots(Array.from({ length: shellCount }, () => shell));
  };

  const handleAddFusedLine = () => {
    const last_shell = shellSlots[shellSlots.length-1]
    const fuse = fuseInventory.find((fuse) => fuse.id === parseInt(fuseType))
    
    // Calculate duration: time from lighting fuse until last shell effect appears
    // Convert fuse lengths (inches) to time (seconds) using burn_rate (seconds per foot)
    const burn_rate = fuse?.burn_rate || 0;
    const lead_in_time = (leadInInches / 12) * burn_rate; // Lead-in fuse burn time
    const total_fuse_length_inches = parseInt(spacing) * shellSlots.length; // Total fuse between shells
    const fuse_burn_time = (total_fuse_length_inches / 12) * burn_rate; // Time for fuse to burn between shells
    const last_shell_delays = (last_shell?.lift_delay || 0) + (last_shell?.fuse_delay || 0); // Last shell's delays
    
    // Total duration = lead-in time + fuse burn time + last shell delays
    const calcDuration = lead_in_time + fuse_burn_time + last_shell_delays;
    
    const name = `${fuse.name} x ${shellSlots.length} shell`
    const fusedLine = {
      type: "FUSED_AERIAL_LINE",
      fuse,
      spacing,
      leadInInches, // Store lead-in inches for delay calculation
      duration: calcDuration,
      shells: shellSlots,
      name
    };
    console.log("HAFL")
    onAdd(fusedLine); // Add the item to the timeline
    onClose(false); // Close the modal
  };


  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-gray-800 text-white p-6 rounded shadow-lg w-96 relative z-50">
        <h2 className="text-xl mb-4">Fused Line Builder</h2>

        {/* Select Fuse Type */}
        <div className="mb-4">
          <label className="block mb-2">Select Fuse Type:</label>
          <select
            className="w-full p-2 bg-gray-700 rounded"
            value={fuseType}
            onChange={(e) => setFuseType(e.target.value)}
          >
            <option value="" disabled>
              -- Select Fuse Type --
            </option>
            {fuseInventory.map((fuse) => (
              <option key={fuse.id} value={fuse.id} >
                {fuse.name} ({fuse.burn_rate} s/f)
              </option>
            ))}
          </select>
        </div>

        {/* Shell Count, Spacing, and Lead-In */}
        <div className="mb-4 flex space-x-4">
          <div>
            <label className="block mb-2">Count of Shells:</label>
            <input
              type="number"
              min="1"
              step="1"
              className="w-full p-2 bg-gray-700 rounded"
              value={shellCount}
              onChange={(e) => setShellCount(Math.max(1, parseInt(e.target.value, 10)))}
            />
          </div>
          <div>
            <label className="block mb-2">Spacing (inches):</label>
            <input
              type="number"
              min="0.01"
              step=".01"
              className="w-full p-2 bg-gray-700 rounded"
              value={spacing}
              onChange={(e) => setSpacing(Math.max(0.01, parseFloat(e.target.value, 10)))}
            />
          </div>
          <div>
            <label className="block mb-2">Lead-In (inches):</label>
            <input
              type="number"
              min="0"
              step=".01"
              className="w-full p-2 bg-gray-700 rounded"
              value={leadInInches}
              onChange={(e) => setLeadInInches(Math.max(0, parseFloat(e.target.value, 10)))}
            />
          </div>
        </div>

        {/* Assign Shells */}
        <div className="mb-4">
          <label className="block mb-2">Assign Shells:</label>
          <div className="space-y-2">
            {shellSlots.map((slot, index) => (
              <div key={index} className="flex items-center space-x-4">
                <span>Slot {index + 1}:</span>
                <select
                  className="flex-grow p-2 bg-gray-700 rounded"
                  value={slot ? slot.id : ""}
                  onChange={(e) => {
                    console.log(e.target.value)
                    console.log(shellInventory)
                    handleAssignShell(
                      index,
                      shellInventory.find((shell) => shell.id === parseInt(e.target.value))
                    )
                }
                  }
                >
                  <option value="">-- Select Shell --</option>
                  {shellInventory.map((shell) => (
                    <option key={shell.id} value={shell.id}>
                      {shell.name}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          <button
            className="mt-4 bg-blue-600 px-4 py-2 rounded w-full"
            onClick={() => {
              const firstShell = shellSlots[0];
              if(firstShell){
                if (firstShell) handleAssignShellToAll(firstShell);
              }
            }}
          >
            Apply First Shell to All Slots
          </button>
        </div>

        {/* Buttons */}
        <div className="flex justify-end space-x-2">
          <button
            className="bg-gray-600 px-4 py-2 rounded"
            onClick={()=>onClose(true)}
          >
            Cancel
          </button>
          <button
            className="bg-blue-600 px-4 py-2 rounded"
            onClick={handleAddFusedLine}
            disabled={fuseType === "" || shellSlots.includes(null)}
          >
            Add Fused Line
          </button>
        </div>
      </div>
    </div>
  );
};

export default FusedLineBuilderModal;