import { MdEdit } from "react-icons/md";
import React, { useState, useMemo } from "react";
import { FaImage, FaVideo } from "react-icons/fa6";

export default function InventoryList({inventory, setActiveItem}) {

    const loadIntoEditor = (inv) => {
        document.getElementById('editForm').scrollIntoView({ behavior: 'smooth' });
        setActiveItem(inv);
    }

    const [sortKey, setSortKey] = useState("name"); // Key to sort by
    const [sortDirection, setSortDirection] = useState("asc"); // 'asc' or 'desc'
    const [filterType, setFilterType] = useState(""); // Filter by type

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
                        <td className="p-1 px-4">{inv.duration}</td>
                        <td className="p-1 px-4">{inv.fuse_delay}</td>
                        <td className="p-1 px-4">{inv.lift_delay}</td>
                        <td className="p-1 px-4">{inv.burn_rate}</td>
                        <td className="p-1 px-1">
                            {inv.image ? <FaImage/> : ""}
                            {inv.youtube_link ? (
                                <a className="hover:text-blue-300" href={inv.youtube_link} target="_blank"><FaVideo/></a>
                            ) : ""}
                        </td>
                        <td className="p-1 px-4" style={{backgroundColor: `${inv.color}${inv.color? 'FF' : ''}`}}></td>
                        <td className="p-1 px-4">
                        <button onClick={()=> {loadIntoEditor(inv)}} className="bg-blue-900 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline flex items-center gap-2" type="button">
                            <MdEdit/>Edit
                        </button>
                        
                        </td>
                    </tr>
                )
            })}
            </tbody>
            </table>
        </div>
    )
}