import { MdEdit } from "react-icons/md";
import React, { useState, useMemo, useEffect } from "react";
import { INV_TYPES } from "@/constants";
import { FaImage, FaVideo, FaChartLine, FaTriangleExclamation } from "react-icons/fa6";
import { FaCheckCircle, FaUpload } from "react-icons/fa";
import axios from "axios";
import ShotProfileModal from "./ShotProfileModal";
import ShellPackEditor from "./ShellPackEditor";
import ImportCatalogModal from "./ImportCatalogModal";

const INVENTORY_ROW_ATTENTION_TYPES = new Set(
    Object.keys(INV_TYPES).filter(
        (k) => k.startsWith("CAKE_") || k === "COMPOUND_CAKE"
    )
);

export default function InventoryList({inventory, setActiveItem, refreshInventory}) {

    const loadIntoEditor = (inv) => {
        setActiveItem(inv);
        // Modal mounts after state update; defer so #editForm exists (optional chaining avoids crash).
        setTimeout(() => {
            document.getElementById("editForm")?.scrollIntoView({
                behavior: "smooth",
                block: "nearest",
            });
        }, 0);
    };

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
    const [isImportModalOpen, setIsImportModalOpen] = useState(false);

    // Handle sorting
    const sortedInventory = useMemo(() => {
        const sorted = [...inventory].sort((a, b) => {
        if (sortKey === "unit_cost") {
            const av = a.unit_cost != null && a.unit_cost !== "" ? Number(a.unit_cost) : null;
            const bv = b.unit_cost != null && b.unit_cost !== "" ? Number(b.unit_cost) : null;
            if (av === null && bv === null) return 0;
            if (av === null) return sortDirection === "asc" ? 1 : -1;
            if (bv === null) return sortDirection === "asc" ? -1 : 1;
            if (av < bv) return sortDirection === "asc" ? -1 : 1;
            if (av > bv) return sortDirection === "asc" ? 1 : -1;
            return 0;
        }
        if (sortKey === "available_ct") {
            const av = a.available_ct != null && a.available_ct !== "" ? Number(a.available_ct) : 0;
            const bv = b.available_ct != null && b.available_ct !== "" ? Number(b.available_ct) : 0;
            const aNum = Number.isNaN(av) ? 0 : av;
            const bNum = Number.isNaN(bv) ? 0 : bv;
            if (aNum < bNum) return sortDirection === "asc" ? -1 : 1;
            if (aNum > bNum) return sortDirection === "asc" ? 1 : -1;
            return 0;
        }
        if (a[sortKey] < b[sortKey]) return sortDirection === "asc" ? -1 : 1;
        if (a[sortKey] > b[sortKey]) return sortDirection === "asc" ? 1 : -1;
        return 0;
        });
        return sorted;
    }, [inventory, sortKey, sortDirection]);

    const formatUnitCost = (val) => {
        if (val === null || val === undefined || val === "") return "—";
        const n = Number(val);
        if (Number.isNaN(n)) return "—";
        return `$${n.toFixed(2)}`;
    };

    const formatAvailableCt = (val) => {
        if (val === null || val === undefined || val === "") return "0";
        const n = Number(val);
        if (Number.isNaN(n)) return "0";
        return String(Math.trunc(n));
    };

    /** Fuse / lift delays for table: F:<n> and/or L:<n> when value is a number ≥ 0 */
    const formatDelayCell = (item) => {
        const parts = [];
        const fd = item.fuse_delay;
        const ld = item.lift_delay;
        const fNum = fd === "" || fd === null || fd === undefined ? NaN : Number(fd);
        const lNum = ld === "" || ld === null || ld === undefined ? NaN : Number(ld);
        if (!Number.isNaN(fNum) && fNum >= 0) {
            parts.push(`F:${fNum}`);
        }
        if (!Number.isNaN(lNum) && lNum >= 0) {
            parts.push(`L:${lNum}`);
        }
        return parts.length ? parts.join(" ") : "—";
    };

    // Handle filtering
    const filteredInventory = useMemo(() => {
        if (!filterType) return sortedInventory;
        return sortedInventory.filter((item) => item.type === filterType);
    }, [sortedInventory, filterType]);

    /** Sum of (available_ct × unit_cost) for rows currently shown (respects type filter). */
    const filteredInventoryTotalValue = useMemo(() => {
        let sum = 0;
        for (const inv of filteredInventory) {
            const qtyRaw =
                inv.available_ct != null && inv.available_ct !== ""
                    ? Number(inv.available_ct)
                    : 0;
            const qty = Number.isNaN(qtyRaw) ? 0 : Math.max(0, Math.trunc(qtyRaw));
            const priceRaw =
                inv.unit_cost != null && inv.unit_cost !== "" ? Number(inv.unit_cost) : NaN;
            if (!Number.isNaN(priceRaw) && priceRaw >= 0) {
                sum += qty * priceRaw;
            }
        }
        return sum;
    }, [filteredInventory]);

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

    const handleGenerateProfile = async (item) => {
        if (!item.id || !item.youtube_link) return;
        
        try {
            const response = await axios.post(`/api/inventory/${item.id}/reprocess-profile`, {
                detectionMethod: 'max_amplitude',
                thresholdRatio: 0.70,
                mergeThresholdMs: 500,
                overrideDuration: false
            });
            
            // Show success message
            alert('Shot profile generation started. This may take a few minutes. The profile will appear when complete.');
            
            // Refresh profiles after a delay
            setTimeout(() => {
                handleReprocessComplete();
            }, 3000);
        } catch (error) {
            console.error('Error generating profile:', error);
            alert(error.response?.data?.error || 'Failed to start profile generation. Please try again.');
        }
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

    const inventoryRowAttention = (item) => {
        if (!INVENTORY_ROW_ATTENTION_TYPES.has(item.type)) {
            return { show: false, title: "" };
        }
        const noDuration =
            item.duration == null ||
            (typeof item.duration === "string" && item.duration.trim() === "");
        const hasYt =
            item.youtube_link && String(item.youtube_link).trim() !== "";
        const start = item.youtube_link_start_sec;
        const ytMissingStart =
            hasYt &&
            (start == null ||
                (typeof start === "string" && start.trim() === ""));
        const show = noDuration || ytMissingStart;
        const reasons = [];
        if (noDuration) reasons.push("Missing duration");
        if (ytMissingStart) reasons.push("YouTube link needs a start time (seconds)");
        return { show, title: reasons.join(". ") };
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
        <div className="min-w-0 w-full space-y-4">
                {/* Filter Dropdown and Import Button */}
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
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
                        <option value="CAKE_350G">Cake 350g</option>
                        <option value="CAKE_500G">Cake 500g</option>
                        <option value="COMPOUND_CAKE">Compound</option>
                        <option value="AERIAL_SHELL">Aerial Shell</option>
                        <option value="GENERIC">Generic</option>
                        <option value="FUSE">Fuse</option>
                        </select>
                    </div>
                    <button
                        onClick={() => setIsImportModalOpen(true)}
                        className="shrink-0 self-start sm:self-auto bg-green-900 hover:bg-green-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline inline-flex items-center gap-2"
                        type="button"
                    >
                        <FaUpload /> Import from Catalog
                    </button>
                </div>

                {/* Batch Reprocess Section */}
                <div className="bg-gray-800 rounded-lg border border-gray-700">
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
        <table className="w-full min-w-0 table-auto bg-gray-800 border border-gray-200 rounded-lg shadow-md">
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
                <th className="py-3 px-6 text-left">Duration</th>
                <th className="py-3 px-6 text-left whitespace-nowrap">Delay</th>
                <th className="py-3 px-6 text-left">Burn Rate</th>
                <th
                    className="py-3 px-4 text-right cursor-pointer whitespace-nowrap"
                    onClick={() => handleSort("available_ct")}
                    title="Quantity on hand"
                >
                    Qty avail {sortKey === "available_ct" && (sortDirection === "asc" ? "↑" : "↓")}
                </th>
                <th
                    className="py-3 px-4 text-left cursor-pointer whitespace-nowrap"
                    onClick={() => handleSort("unit_cost")}
                >
                    Unit cost {sortKey === "unit_cost" && (sortDirection === "asc" ? "↑" : "↓")}
                </th>
                <th className="py-3 px-1 text-left">Tags</th>
                <th className="py-3 px-6 text-left">Color</th>
                <th className="py-3 px-6 text-left">Source</th>
                <th className="py-3 px-6 text-left">Actions</th>
                </tr>
            </thead>
            <tbody  className="text-gray-6400 text-sm font-light">
            {filteredInventory.map((inv,ki) => {
                const attention = inventoryRowAttention(inv);
                return (
                    <tr key={ki} className={`${
                  ki % 2 === 0 ? "bg-gray-900" : "bg-gray-800"
                } hover:bg-gray-700`}>
                        <td className="p-1 px-4">
                            <div className="flex items-center gap-2 min-w-0">
                                {attention.show && (
                                    <span
                                        className="inline-flex shrink-0 text-yellow-400"
                                        title={attention.title}
                                        role="img"
                                        aria-label={attention.title}
                                    >
                                        <FaTriangleExclamation aria-hidden />
                                    </span>
                                )}
                                <span className="min-w-0">{inv.name}</span>
                            </div>
                        </td>
                        <td className="p-1 px-4">{inv.type}</td>
                        <td className="p-1 px-4">{inv.duration}</td>
                        <td className="p-1 px-4 font-mono text-xs whitespace-nowrap" title="Fuse delay (F) / lift delay (L)">
                            {formatDelayCell(inv)}
                        </td>
                        <td className="p-1 px-4">{inv.burn_rate}</td>
                        <td className="p-1 px-4 text-right tabular-nums">{formatAvailableCt(inv.available_ct)}</td>
                        <td className="p-1 px-4 text-right tabular-nums">{formatUnitCost(inv.unit_cost)}</td>
                        <td className="p-1 px-1">
                            <div className="flex items-center gap-2">
                                {inv.image ? <FaImage/> : ""}
                                {inv.youtube_link ? (
                                    <a className="hover:text-blue-300" href={inv.youtube_link} target="_blank"><FaVideo/></a>
                                ) : ""}
                                {inv.youtube_link && inv.youtube_link.trim() !== '' && (
                                    firingProfiles[inv.id] ? (
                                        <button
                                            onClick={() => handleShowProfile(inv)}
                                            className="hover:text-blue-300 text-blue-400"
                                            title="View Shot Profile"
                                        >
                                            <FaChartLine/>
                                        </button>
                                    ) : (
                                        <button
                                            onClick={() => handleGenerateProfile(inv)}
                                            className="hover:text-yellow-300 text-yellow-400"
                                            title="Generate Shot Profile"
                                        >
                                            <FaChartLine/>
                                        </button>
                                    )
                                )}
                            </div>
                        </td>
                        <td className="p-1 px-4" style={{backgroundColor: `${inv.color}${inv.color? 'FF' : ''}`}}></td>
                        <td className="p-1 px-4">
                            <span className={`px-2 py-1 rounded text-xs ${
                                inv.source === 'imported' 
                                    ? 'bg-blue-900 text-blue-200' 
                                    : 'bg-gray-700 text-gray-300'
                            }`}>
                                {inv.source || 'user_created'}
                            </span>
                        </td>
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
            <p className="text-sm text-gray-400 mt-3 text-right tabular-nums">
                Total value (qty × unit cost, items above)
                {filterType ? " — filtered" : ""}
                :{" "}
                {filteredInventoryTotalValue.toLocaleString("en-US", {
                    style: "currency",
                    currency: "USD",
                })}
            </p>
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
            <ImportCatalogModal
                isOpen={isImportModalOpen}
                onClose={() => setIsImportModalOpen(false)}
                onImportComplete={() => {
                    // Refresh inventory list
                    if (refreshInventory) {
                        refreshInventory();
                    }
                }}
            />
        </div>
    )
}