import { MdEdit } from "react-icons/md";
import React, { useState, useMemo, useEffect } from "react";
import { FaImage, FaVideo, FaChartLine } from "react-icons/fa6";
import { FaCheckCircle } from "react-icons/fa";
import axios from "axios";
import ShotProfileModal from "./ShotProfileModal";
import ShellPackEditor from "./ShellPackEditor";

export default function InventoryList({inventory, setActiveItem}) {

    const loadIntoEditor = (inv) => {
        document.getElementById('editForm').scrollIntoView({ behavior: 'smooth' });
        setActiveItem(inv);
    }

    const [sortKey, setSortKey] = useState("name"); // Key to sort by
    const [sortDirection, setSortDirection] = useState("asc"); // 'asc' or 'desc'
    const [filterType, setFilterType] = useState(""); // Filter by type
    const [firingProfiles, setFiringProfiles] = useState({}); // Map of inventory_id -> firing profile
    const [selectedProfileItem, setSelectedProfileItem] = useState(null); // Item for which to show profile modal
    const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
    const [isBatchReprocessOpen, setIsBatchReprocessOpen] = useState(false); // Collapsed section state
    const [detectionMethod, setDetectionMethod] = useState('max_amplitude'); // Detection method
    const [thresholdRatio, setThresholdRatio] = useState(0.70); // Default threshold ratio
    const [thresholdRatioInput, setThresholdRatioInput] = useState('0.70'); // String for input
    const [floorPercent, setFloorPercent] = useState(10.0); // Default floor percent
    const [floorPercentInput, setFloorPercentInput] = useState('10.0'); // String for input
    const [mergeThresholdMs, setMergeThresholdMs] = useState(500); // Default merge threshold
    const [mergeThresholdMsInput, setMergeThresholdMsInput] = useState('500'); // String for input
    const [reprocessAll, setReprocessAll] = useState(false); // Overwrite existing profiles
    const [overrideDuration, setOverrideDuration] = useState(false); // Override duration based on shots
    const [isBatchProcessing, setIsBatchProcessing] = useState(false); // Processing state
    const [batchStatus, setBatchStatus] = useState(null); // Status message
    const [selectedShellPackItem, setSelectedShellPackItem] = useState(null); // Item for which to show shell pack editor
    const [isShellPackEditorOpen, setIsShellPackEditorOpen] = useState(false);

    // Handle sorting
    const sortedInventory = useMemo(() => {
        const sorted = [...inventory].sort((a, b) => {
        if (a[sortKey] < b[sortKey]) return sortDirection === "asc" ? -1 : 1;
        if (a[sortKey] > b[sortKey]) return sortDirection === "asc" ? 1 : -1;
        return 0;
        });
        return sorted;
    }, [inventory, sortKey, sortDirection]);

    // Handle filtering
    const filteredInventory = useMemo(() => {
        if (!filterType) return sortedInventory;
        return sortedInventory.filter((item) => item.type === filterType);
    }, [sortedInventory, filterType]);

    // Toggle sort direction
    const handleSort = (key) => {
        if (sortKey === key) {
        setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
        } else {
        setSortKey(key);
        setSortDirection("asc");
        }
    };

    // Fetch firing profiles for all inventory items
    useEffect(() => {
        const fetchFiringProfiles = async () => {
            const profiles = {};
            const promises = inventory.map(async (item) => {
                try {
                    const response = await axios.get(`/api/inventory/${item.id}/firing-profile`);
                    if (response.data) {
                        profiles[item.id] = response.data;
                    }
                } catch (error) {
                    // Profile doesn't exist for this item, which is fine
                    if (error.response?.status !== 404) {
                        console.error(`Error fetching firing profile for item ${item.id}:`, error);
                    }
                }
            });
            await Promise.all(promises);
            setFiringProfiles(profiles);
        };

        if (inventory.length > 0) {
            fetchFiringProfiles();
        }
    }, [inventory]);

    const handleShowProfile = (item) => {
        setSelectedProfileItem(item);
        setIsProfileModalOpen(true);
    };

    const handleCloseProfileModal = () => {
        setIsProfileModalOpen(false);
        setSelectedProfileItem(null);
    };

    const handleReprocessComplete = async () => {
        // Refresh firing profiles after reprocessing
        const profiles = {};
        const promises = inventory.map(async (item) => {
            try {
                const response = await axios.get(`/api/inventory/${item.id}/firing-profile`);
                if (response.data) {
                    profiles[item.id] = response.data;
                }
            } catch (error) {
                // Profile doesn't exist for this item, which is fine
                if (error.response?.status !== 404) {
                    console.error(`Error fetching firing profile for item ${item.id}:`, error);
                }
            }
        });
        await Promise.all(promises);
        setFiringProfiles(profiles);
    };

    const handleBatchReprocess = async () => {
        setIsBatchProcessing(true);
        setBatchStatus(null);

        try {
            const response = await axios.post('/api/inventory/reprocess-all-profiles', {
                detectionMethod: detectionMethod,
                thresholdRatio: detectionMethod === 'max_amplitude' ? thresholdRatio : undefined,
                floorPercent: detectionMethod === 'noise_floor' ? floorPercent : undefined,
                mergeThresholdMs: mergeThresholdMs,
                reprocessAll: reprocessAll,
                overrideDuration: overrideDuration
            });
            
            setBatchStatus({
                success: true,
                message: response.data.message || 'Batch reprocessing started. This may take several minutes. Profiles will be updated when complete.'
            });

            // Refresh profiles after a delay (give it time to process)
            setTimeout(() => {
                handleReprocessComplete();
            }, 5000);
        } catch (error) {
            console.error('Error starting batch reprocess:', error);
            setBatchStatus({
                success: false,
                message: error.response?.data?.error || 'Failed to start batch reprocessing. Please try again.'
            });
        } finally {
            setIsBatchProcessing(false);
        }
    };

    // Check if an item has shell pack data
    const hasShellPackData = (item) => {
        if (!item || item.type !== 'AERIAL_SHELL' || !item.metadata) {
            return false;
        }
        try {
            const metadata = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;
            const packData = metadata?.pack_shell_data;
            return packData && packData.shells && Array.isArray(packData.shells) && packData.shells.length > 0;
        } catch (e) {
            return false;
        }
    };

    return (
        <div className="w-3/4 mr-4">
            <div className="container mx-auto p-4">
                {/* Filter Dropdown */}
                <div className="mb-4">
                    <label htmlFor="filter" className="mr-2 font-bold">Filter by Type:</label>
                    <select
                    id="filter"
                    value={filterType}
                    onChange={(e) => setFilterType(e.target.value)}
                    className="border p-2 rounded"
                    >
                    <option value="">All</option>
                    <option value="CAKE_FOUNTAIN">Cake Fountain</option>
                    <option value="CAKE_200G">Cake 200g</option>
                    <option value="CAKE_500G">Cake 500g</option>
                    <option value="AERIAL_SHELL">Aerial Shell</option>
                    <option value="GENERIC">Generic</option>
                    <option value="FUSE">Fuse</option>
                    </select>
                </div>

                {/* Batch Reprocess Section */}
                <div className="mb-4 bg-gray-800 rounded-lg border border-gray-700">
                    <button
                        onClick={() => setIsBatchReprocessOpen(!isBatchReprocessOpen)}
                        className="w-full px-4 py-3 flex justify-between items-center text-left hover:bg-gray-700 transition-colors"
                    >
                        <span className="font-bold text-white">
                            Batch Regenerate Shot Profiles
                        </span>
                        <span className="text-gray-400">
                            {isBatchReprocessOpen ? '▼' : '▶'}
                        </span>
                    </button>
                    
                    {isBatchReprocessOpen && (
                        <div className="px-4 pb-4 space-y-4">
                            <div className="pt-2">
                                <div className="mb-3">
                                    <label className="block text-gray-200 text-sm font-bold mb-2">
                                        Detection Method
                                    </label>
                                    <select
                                        value={detectionMethod}
                                        onChange={(e) => setDetectionMethod(e.target.value)}
                                        className="shadow appearance-none border rounded w-full py-2 px-3 text-white bg-gray-700 border-gray-600 leading-tight focus:outline-none focus:shadow-outline"
                                    >
                                        <option value="max_amplitude">Max Amplitude</option>
                                        <option value="noise_floor">Noise Floor</option>
                                    </select>
                                </div>
                                <div className="flex gap-4">
                                    {detectionMethod === 'max_amplitude' ? (
                                        <div className="flex-1">
                                            <label className="block text-gray-200 text-sm font-bold mb-2">
                                                Threshold Ratio (0.0 - 1.0)
                                            </label>
                                            <input
                                                type="number"
                                                min="0"
                                                max="1"
                                                step="0.01"
                                                value={thresholdRatioInput}
                                                onChange={(e) => {
                                                  const val = e.target.value;
                                                  setThresholdRatioInput(val);
                                                  const num = parseFloat(val);
                                                  if (!isNaN(num) && num >= 0 && num <= 1) {
                                                    setThresholdRatio(num);
                                                  }
                                                }}
                                                onBlur={(e) => {
                                                  const val = e.target.value;
                                                  const num = parseFloat(val);
                                                  if (val === '' || isNaN(num) || num < 0 || num > 1) {
                                                    setThresholdRatioInput(thresholdRatio.toString());
                                                  }
                                                }}
                                                className="shadow appearance-none border rounded w-full py-2 px-3 text-white bg-gray-700 border-gray-600 leading-tight focus:outline-none focus:shadow-outline"
                                            />
                                            <p className="text-gray-400 text-xs italic mt-1">
                                                Lower = more sensitive (default: 0.70)
                                            </p>
                                        </div>
                                    ) : (
                                        <div className="flex-1">
                                            <label className="block text-gray-200 text-sm font-bold mb-2">
                                                Floor Percent (%)
                                            </label>
                                            <input
                                                type="number"
                                                min="0"
                                                step="0.1"
                                                value={floorPercentInput}
                                                onChange={(e) => {
                                                  const val = e.target.value;
                                                  setFloorPercentInput(val);
                                                  const num = parseFloat(val);
                                                  if (!isNaN(num) && num >= 0) {
                                                    setFloorPercent(num);
                                                  }
                                                }}
                                                onBlur={(e) => {
                                                  const val = e.target.value;
                                                  const num = parseFloat(val);
                                                  if (val === '' || isNaN(num) || num < 0) {
                                                    setFloorPercentInput(floorPercent.toString());
                                                  }
                                                }}
                                                className="shadow appearance-none border rounded w-full py-2 px-3 text-white bg-gray-700 border-gray-600 leading-tight focus:outline-none focus:shadow-outline"
                                            />
                                            <p className="text-gray-400 text-xs italic mt-1">
                                                % above noise floor (default: 10.0%)
                                            </p>
                                        </div>
                                    )}

                                    <div className="flex-1">
                                        <label className="block text-gray-200 text-sm font-bold mb-2">
                                            Merge Threshold (ms)
                                        </label>
                                        <input
                                            type="number"
                                            min="0"
                                            step="50"
                                            value={mergeThresholdMsInput}
                                            onChange={(e) => {
                                              const val = e.target.value;
                                              setMergeThresholdMsInput(val);
                                              const num = parseInt(val);
                                              if (!isNaN(num) && num >= 0) {
                                                setMergeThresholdMs(num);
                                              }
                                            }}
                                            onBlur={(e) => {
                                              const val = e.target.value;
                                              const num = parseInt(val);
                                              if (val === '' || isNaN(num) || num < 0) {
                                                setMergeThresholdMsInput(mergeThresholdMs.toString());
                                              }
                                            }}
                                            className="shadow appearance-none border rounded w-full py-2 px-3 text-white bg-gray-700 border-gray-600 leading-tight focus:outline-none focus:shadow-outline"
                                        />
                                        <p className="text-gray-400 text-xs italic mt-1">
                                            Gap to merge shots (default: 500ms)
                                        </p>
                                    </div>
                                </div>
                            </div>

                            <div className="space-y-3">
                                <div>
                                    <label className="flex items-center text-gray-200 text-sm">
                                        <input
                                            type="checkbox"
                                            checked={reprocessAll}
                                            onChange={(e) => setReprocessAll(e.target.checked)}
                                            className="mr-2"
                                        />
                                        <span className="font-bold">Overwrite Existing Profiles</span>
                                    </label>
                                    <p className="text-gray-400 text-xs italic mt-1">
                                        If checked, will reprocess all items with YouTube links, even if they already have profiles.
                                    </p>
                                </div>
                                <div>
                                    <label className="flex items-center text-gray-200 text-sm">
                                        <input
                                            type="checkbox"
                                            checked={overrideDuration}
                                            onChange={(e) => setOverrideDuration(e.target.checked)}
                                            className="mr-2"
                                        />
                                        <span className="font-bold">Override Duration</span>
                                    </label>
                                    <p className="text-gray-400 text-xs italic mt-1">
                                        Set item duration based on end of last shot (assumes video starts at 0).
                                    </p>
                                </div>
                            </div>

                            <div className="flex items-center gap-2">
                                <button
                                    onClick={handleBatchReprocess}
                                    disabled={isBatchProcessing}
                                    className="bg-blue-900 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline"
                                >
                                    {isBatchProcessing ? 'Processing...' : 'Start Batch Reprocess'}
                                </button>
                                {batchStatus && (
                                    <p className={`text-sm ${batchStatus.success ? 'text-green-400' : 'text-red-400'}`}>
                                        {batchStatus.message}
                                    </p>
                                )}
                            </div>
                        </div>
                    )}
                </div>
                </div>
        <table className="table-auto bg-gray-800 border border-gray-200 rounded-lg shadow-md">
            <thead>
                <tr className="bg-gray-600 text-gray-200 uppercase text-sm leading-normal">
                <th
                    className="py-3 px-6 text-left cursor-pointer"
                    onClick={() => handleSort("name")}
                >
                Name {sortKey === "name" && (sortDirection === "asc" ? "↑" : "↓")}
                </th>
                <th
                    className="py-3 px-6 text-left cursor-pointer"
                    onClick={() => handleSort("type")}
                >
                Type {sortKey === "type" && (sortDirection === "asc" ? "↑" : "↓")}
                </th>
                <th className="py-3 px-2 text-left">QA</th>
                <th className="py-3 px-6 text-left">Duration</th>
                <th className="py-3 px-6 text-left">Fuse Delay</th>
                <th className="py-3 px-6 text-left">Lift Delay</th>
                <th className="py-3 px-6 text-left">Burn Rate</th>
                <th className="py-3 px-1 text-left">Tags</th>
                <th className="py-3 px-6 text-left">Color</th>
                <th className="py-3 px-6 text-left">Actions</th>
                </tr>
            </thead>
            <tbody  className="text-gray-6400 text-sm font-light">
            {filteredInventory.map((inv,ki) => {
                return (
                    <tr key={ki} className={`${
                  ki % 2 === 0 ? "bg-gray-900" : "bg-gray-800"
                } hover:bg-gray-700`}>
                        <td className="p-1 px-4">{inv.name}</td>
                        <td className="p-1 px-4">{inv.type}</td>
                        <td className="p-1 px-2 text-center">{inv.available_ct ?? 0}</td>
                        <td className="p-1 px-4">{inv.duration}</td>
                        <td className="p-1 px-4">{inv.fuse_delay}</td>
                        <td className="p-1 px-4">{inv.lift_delay}</td>
                        <td className="p-1 px-4">{inv.burn_rate}</td>
                        <td className="p-1 px-1">
                            <div className="flex items-center gap-2">
                                {inv.image ? <FaImage/> : ""}
                                {inv.youtube_link ? (
                                    <a className="hover:text-blue-300" href={inv.youtube_link} target="_blank"><FaVideo/></a>
                                ) : ""}
                                {(firingProfiles[inv.id] || (inv.youtube_link && inv.youtube_link.trim() !== '' && inv.youtube_link_start_sec !== null)) && (
                                    <button
                                        onClick={() => handleShowProfile(inv)}
                                        className="hover:text-blue-300 text-blue-400"
                                        title={firingProfiles[inv.id] ? "View Shot Profile" : "Generate/View Shot Profile"}
                                    >
                                        <FaChartLine/>
                                    </button>
                                )}
                            </div>
                        </td>
                        <td className="p-1 px-4" style={{backgroundColor: `${inv.color}${inv.color? 'FF' : ''}`}}></td>
                        <td className="p-1 px-4">
                        <div className="flex gap-2">
                            <button onClick={()=> {loadIntoEditor(inv)}} className="bg-blue-900 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline flex items-center gap-2" type="button">
                                <MdEdit/>Edit
                            </button>
                            {inv.type === "AERIAL_SHELL" && (
                                <button 
                                    onClick={() => {
                                        setSelectedShellPackItem(inv);
                                        setIsShellPackEditorOpen(true);
                                    }} 
                                    className="bg-purple-900 hover:bg-purple-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline flex items-center gap-2" 
                                    type="button"
                                    title="Edit Shell Pack"
                                >
                                    Shells
                                    {hasShellPackData(inv) && (
                                        <FaCheckCircle className="text-green-400" title="Has shell data" />
                                    )}
                                </button>
                            )}
                        </div>
                        </td>
                    </tr>
                )
            })}
            </tbody>
            </table>
            <ShotProfileModal
                isVisible={isProfileModalOpen}
                item={selectedProfileItem}
                firingProfile={selectedProfileItem ? firingProfiles[selectedProfileItem.id] : null}
                onClose={handleCloseProfileModal}
                onReprocessComplete={handleReprocessComplete}
            />
            <ShellPackEditor
                isOpen={isShellPackEditorOpen}
                onClose={() => {
                    setIsShellPackEditorOpen(false);
                    setSelectedShellPackItem(null);
                }}
                item={selectedShellPackItem}
            />
        </div>
    )
}