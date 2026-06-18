import React, { useState, useEffect, useMemo, useCallback } from "react";
import axios from "axios";
import { INV_TYPES } from "@/constants";
import useAppStore from '@/store/useAppStore';
import { apiUrl } from '@/util/clientEnv';

// Note: Type mapping is now done in gather.py, so we just use the type directly from records

// Define which columns can be populated from catalog data
const POPULATABLE_COLUMNS = {
  name: { source: 'catalog.fw_name', canPopulate: true },
  type: { source: 'catalog.type (pre-mapped)', canPopulate: true },
  duration: { source: 'catalog.duration', canPopulate: true, note: 'May be 0 if not specified' },
  fuse_delay: { source: 'N/A', canPopulate: false },
  lift_delay: { source: 'N/A', canPopulate: false },
  burn_rate: { source: 'N/A', canPopulate: false },
  color: { source: 'N/A', canPopulate: false },
  available_ct: { source: 'defaults to 0', canPopulate: true, note: 'Set to 0 on import' },
  youtube_link: { source: 'catalog.yt_url', canPopulate: true },
  youtube_link_start_sec: { source: 'N/A', canPopulate: false },
  image: { source: 'N/A', canPopulate: false, note: 'Not included in catalog' },
  metadata: { source: 'catalog fields', canPopulate: true, note: 'Stores brand, original_type' },
  source: { source: 'set to "imported"', canPopulate: true }
};

export default function ImportCatalogModal({ isOpen, onClose, onImportComplete }) {
  const { createInventoryItem, fetchInventory } = useAppStore();
  const [catalogData, setCatalogData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [catalogNotFound, setCatalogNotFound] = useState(false);
  const [selectedItems, setSelectedItems] = useState(new Set());
  const [importing, setImporting] = useState(false);
  const [filterType, setFilterType] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [showColumnInfo, setShowColumnInfo] = useState(false);
  const [crawlProgress, setCrawlProgress] = useState(null);
  const [refreshingCatalog, setRefreshingCatalog] = useState(false);
  const [progressPollInterval, setProgressPollInterval] = useState(null);
  const [selectedBrands, setSelectedBrands] = useState(new Set());
  const [selectedTypes, setSelectedTypes] = useState(new Set());
  const [hasImage, setHasImage] = useState(false);
  const [hasVideo, setHasVideo] = useState(false);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [sortColumn, setSortColumn] = useState('name'); // 'name' or 'brand'
  const [sortDirection, setSortDirection] = useState('asc'); // 'asc' or 'desc'

  // Load catalog.json when modal opens
  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setError(null);
    setCatalogNotFound(false);
    try {
      const res = await fetch(apiUrl('/api/catalog'));
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        if (res.status === 404) {
          setCatalogNotFound(true);
          setLoading(false);
          return;
        }
        throw new Error(errorData.error || `HTTP error! status: ${res.status}`);
      }
      const data = await res.json();
      setCatalogData(data);
      setCatalogNotFound(false);
      setLoading(false);
    } catch (err) {
      console.error('Error loading catalog:', err);
      setError(err.message || 'Failed to load catalog.json. Please try refreshing the catalog.');
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen && !catalogData) {
      loadCatalog();
    }
  }, [isOpen, catalogData, loadCatalog]);

  // Poll for crawl progress
  useEffect(() => {
    if (refreshingCatalog) {
      const interval = setInterval(async () => {
        try {
          const res = await fetch(apiUrl('/api/catalog/refresh'));
          const progress = await res.json();
          setCrawlProgress(progress);
          
          // If crawl completed, reload catalog
          if (progress.status === 'completed') {
            setRefreshingCatalog(false);
            await loadCatalog();
            setCrawlProgress(null);
          } else if (progress.status === 'error') {
            setRefreshingCatalog(false);
            setCrawlProgress(null);
          }
        } catch (err) {
          console.error('Error fetching progress:', err);
        }
      }, 1000); // Poll every second
      
      setProgressPollInterval(interval);
      
      return () => {
        if (interval) clearInterval(interval);
      };
    } else {
      if (progressPollInterval) {
        clearInterval(progressPollInterval);
        setProgressPollInterval(null);
      }
    }
  }, [refreshingCatalog, loadCatalog]);

  // Cleanup interval on unmount
  useEffect(() => {
    return () => {
      if (progressPollInterval) {
        clearInterval(progressPollInterval);
      }
    };
  }, [progressPollInterval]);

  // Extract unique brands and types from catalog
  const availableBrands = useMemo(() => {
    if (!catalogData || !catalogData.records) return [];
    const brands = new Set();
    catalogData.records.forEach(record => {
      if (record.brand) {
        brands.add(record.brand);
      }
    });
    return Array.from(brands).sort();
  }, [catalogData]);

  const availableTypes = useMemo(() => {
    if (!catalogData || !catalogData.records) return [];
    const types = new Set();
    catalogData.records.forEach(record => {
      if (record.type) {
        types.add(record.type);
      }
    });
    return Array.from(types).sort();
  }, [catalogData]);

  // Process catalog records into importable items (new format only)
  const importableItems = useMemo(() => {
    if (!catalogData || !catalogData.records) return [];
    
    return catalogData.records
      .filter(record => {
        // Filter by search term
        if (searchTerm) {
          const searchLower = searchTerm.toLowerCase();
          const name = record.fw_name || '';
          const brand = record.brand || '';
          if (!(name.toLowerCase().includes(searchLower) ||
                brand.toLowerCase().includes(searchLower))) {
            return false;
          }
        }
        
        // Filter by brand (multiselect)
        if (selectedBrands.size > 0) {
          if (!record.brand || !selectedBrands.has(record.brand)) {
            return false;
          }
        }
        
        // Filter by has image (new format doesn't have images)
        if (hasImage) {
          return false; // New format doesn't include images
        }
        
        // Filter by has video
        if (hasVideo && !record.yt_url) {
          return false;
        }
        
        return true;
      })
      .map(record => {
        return {
          catalogId: null, // New format doesn't include id
          name: record.fw_name || 'Unnamed',
          type: record.type || 'UNKNOWN',
          originalType: record.type || 'Unknown', // Use type as original since we don't have original_type
          duration: record.duration && record.duration > 0 ? record.duration : null,
          description: '',
          brand: record.brand || '',
          image: null, // New format doesn't include images
          video: record.yt_url || null,
          website: null, // New format doesn't include website
          metadata: null // New format doesn't include metadata
        };
      })
      .filter(item => {
        // Filter by type (multiselect)
        if (selectedTypes.size > 0) {
          if (!item.type || !selectedTypes.has(item.type)) {
            return false;
          }
        }
        
        // Legacy filterType support (single select)
        if (filterType && item.type !== filterType) {
          return false;
        }
        
        return true;
      })
      .sort((a, b) => {
        // Apply sorting
        let aValue, bValue;
        
        if (sortColumn === 'name') {
          aValue = (a.name || '').toLowerCase();
          bValue = (b.name || '').toLowerCase();
        } else if (sortColumn === 'brand') {
          aValue = (a.brand || '').toLowerCase();
          bValue = (b.brand || '').toLowerCase();
        } else {
          return 0;
        }
        
        if (aValue < bValue) {
          return sortDirection === 'asc' ? -1 : 1;
        }
        if (aValue > bValue) {
          return sortDirection === 'asc' ? 1 : -1;
        }
        return 0;
      });
  }, [catalogData, searchTerm, selectedBrands, selectedTypes, hasImage, hasVideo, filterType, sortColumn, sortDirection]);

  const handleToggleItem = (index) => {
    const newSelected = new Set(selectedItems);
    if (newSelected.has(index)) {
      newSelected.delete(index);
    } else {
      newSelected.add(index);
    }
    setSelectedItems(newSelected);
  };

  const handleSelectAll = () => {
    if (selectedItems.size === importableItems.length) {
      setSelectedItems(new Set());
    } else {
      setSelectedItems(new Set(importableItems.map((_, i) => i)));
    }
  };

  const handleSort = (column) => {
    if (sortColumn === column) {
      // Toggle direction if clicking the same column
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      // Set new column and default to ascending
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  const handleRefreshCatalog = async () => {
    setRefreshingCatalog(true);
    setCrawlProgress(null);
    setError(null);
    
    try {
      const res = await fetch(apiUrl('/api/catalog/refresh'), {
        method: 'POST'
      });
      
      if (!res.ok) {
        const data = await res.json();
        if (res.status === 409) {
          // Already running, get current progress
          setCrawlProgress(data.progress);
        } else {
          throw new Error(data.error || 'Failed to start catalog refresh');
        }
      } else {
        // Started successfully, will poll for progress
        setCrawlProgress({
          status: 'running',
          current: 0,
          total: 0,
          message: 'Starting catalog crawl...'
        });
      }
    } catch (err) {
      console.error('Error starting catalog refresh:', err);
      setError(`Failed to start catalog refresh: ${err.message}`);
      setRefreshingCatalog(false);
    }
  };

  const handleImport = async () => {
    if (selectedItems.size === 0) {
      alert('Please select at least one item to import');
      return;
    }

    setImporting(true);
    const itemsToImport = Array.from(selectedItems).map(index => importableItems[index]);
    
    try {
      let successCount = 0;
      let errorCount = 0;
      
      for (const item of itemsToImport) {
        try {
          // For imported items, set default values for required fields that aren't in catalog
          // FUSE requires burn_rate and color
          // AERIAL_SHELL requires fuse_delay and lift_delay
          let fuse_delay = null;
          let lift_delay = null;
          let burn_rate = null;
          let color = null;
          
          if (item.type === 'FUSE') {
            // Set defaults for FUSE (user can update later)
            burn_rate = 1.0; // Default 1 sec/ft
            color = '#FFFFFF'; // Default white
          } else if (item.type === 'AERIAL_SHELL') {
            // Set defaults for AERIAL_SHELL (user can update later)
            fuse_delay = 0.0; // Default 0 seconds
            lift_delay = 0.0; // Default 0 seconds
          }
          
          const inventoryItem = {
            name: item.name,
            type: item.type,
            duration: item.duration || null,
            fuse_delay: fuse_delay,
            lift_delay: lift_delay,
            burn_rate: burn_rate,
            color: color,
            available_ct: 0,
            youtube_link: item.video || null,
            youtube_link_start_sec: null,
            image: item.image || null,
            metadata: null, // New format doesn't include metadata
            source: 'imported'
          };
          
          await createInventoryItem(inventoryItem);
          successCount++;
        } catch (err) {
          console.error(`Error importing item ${item.name}:`, err);
          errorCount++;
        }
      }
      
      // Refresh inventory
      await fetchInventory();
      
      alert(`Import complete! ${successCount} items imported successfully${errorCount > 0 ? `, ${errorCount} failed` : ''}`);
      
      // Reset and close
      setSelectedItems(new Set());
      onImportComplete?.();
      onClose();
    } catch (err) {
      console.error('Error during import:', err);
      alert('Error during import. Please check the console for details.');
    } finally {
      setImporting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg shadow-xl w-11/12 max-w-6xl max-h-[90vh] flex flex-col">
        <div className="p-6 border-b border-gray-700">
          <div className="flex justify-between items-start">
            <div>
              <h2 className="text-2xl font-bold text-white">Import from Catalog</h2>
              <p className="text-gray-400 text-sm mt-2">
                Preview and select items to import from catalog.json. Selected items will be imported with source="imported".
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleRefreshCatalog}
                disabled={refreshingCatalog}
                className="px-4 py-2 bg-green-900 hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded text-sm flex items-center gap-2"
                title="Refresh catalog from backyard-hero.com"
              >
                {refreshingCatalog ? 'Refreshing...' : 'Refresh Catalog'}
              </button>
              <button
                onClick={() => setShowColumnInfo(!showColumnInfo)}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded text-sm"
                title="Show which columns can be populated"
              >
                {showColumnInfo ? 'Hide' : 'Show'} Column Info
              </button>
            </div>
          </div>
          
          {/* Crawl Progress Display */}
          {crawlProgress && (
            <div className="mt-4 p-4 bg-gray-900 rounded border border-gray-700">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-lg font-bold text-white">Catalog Refresh Progress</h3>
                <span className={`px-2 py-1 rounded text-xs ${
                  crawlProgress.status === 'running' ? 'bg-blue-900 text-blue-200' :
                  crawlProgress.status === 'completed' ? 'bg-green-900 text-green-200' :
                  'bg-red-900 text-red-200'
                }`}>
                  {crawlProgress.status.toUpperCase()}
                </span>
              </div>
              {crawlProgress.status === 'running' && crawlProgress.total > 1 && (
                <div className="mb-2">
                  <div className="w-full bg-gray-700 rounded-full h-2.5">
                    <div 
                      className="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
                      style={{ width: `${(crawlProgress.current / crawlProgress.total) * 100}%` }}
                    ></div>
                  </div>
                  <div className="text-gray-300 text-sm mt-1">
                    {crawlProgress.current} / {crawlProgress.total} pages
                  </div>
                </div>
              )}
              <p className="text-gray-300 text-sm">{crawlProgress.message}</p>
              {crawlProgress.status === 'completed' && (
                <button
                  onClick={loadCatalog}
                  className="mt-2 px-4 py-2 bg-blue-900 hover:bg-blue-700 text-white rounded text-sm"
                >
                  Reload Catalog
                </button>
              )}
            </div>
          )}
          
          {/* Column Information Panel */}
          {showColumnInfo && (
            <div className="mt-4 p-4 bg-gray-900 rounded border border-gray-700">
              <h3 className="text-lg font-bold text-white mb-3">Columns That Can Be Populated from Catalog:</h3>
              <div className="grid grid-cols-2 gap-2 text-sm">
                {Object.entries(POPULATABLE_COLUMNS).map(([column, info]) => (
                  <div key={column} className={`p-2 rounded ${info.canPopulate ? 'bg-green-900/30 border border-green-700' : 'bg-gray-800 border border-gray-700'}`}>
                    <div className="font-semibold text-white">{column}</div>
                    <div className="text-gray-300 text-xs mt-1">{info.source}</div>
                    {info.note && (
                      <div className="text-gray-400 text-xs italic mt-1">{info.note}</div>
                    )}
                  </div>
                ))}
              </div>
              <p className="text-gray-400 text-xs mt-3 italic">
                Note: Columns not populated from catalog will be set to null (or default values). You can edit these after import.
              </p>
            </div>
          )}
        </div>

        <div className="p-6 flex-1 overflow-hidden flex flex-col">
          {/* Collapsible Filters */}
          <div className="mb-4 bg-gray-900 rounded-lg border border-gray-700">
            <button
              onClick={() => setFiltersExpanded(!filtersExpanded)}
              className="w-full px-4 py-3 flex justify-between items-center text-left hover:bg-gray-800 transition-colors"
            >
              <div className="flex items-center gap-2">
                <span className="font-bold text-white">Filters</span>
                {(selectedBrands.size > 0 || selectedTypes.size > 0 || hasImage || hasVideo || searchTerm || filterType) && (
                  <span className="px-2 py-1 bg-blue-900 text-blue-200 rounded text-xs">
                    Active
                  </span>
                )}
              </div>
              <span className="text-gray-400">
                {filtersExpanded ? '▼' : '▶'}
              </span>
            </button>
            
            {filtersExpanded && (
              <div className="px-4 pb-4 space-y-3 pt-2">
                {/* Search */}
                <div>
                  <input
                    type="text"
                    placeholder="Search by name, brand, or description..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full px-4 py-2 bg-gray-700 text-white rounded border border-gray-600 focus:outline-none focus:border-blue-500"
                  />
                </div>
                
                {/* Filter Row */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
              {/* Brand Multiselect */}
              <div>
                <label className="block text-gray-300 text-sm font-bold mb-1">Brand</label>
                <select
                  multiple
                  value={Array.from(selectedBrands)}
                  onChange={(e) => {
                    const newSelected = new Set(Array.from(e.target.selectedOptions, option => option.value));
                    setSelectedBrands(newSelected);
                  }}
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded border border-gray-600 focus:outline-none focus:border-blue-500 min-h-[100px]"
                  size={5}
                >
                  {availableBrands.map(brand => (
                    <option key={brand} value={brand}>{brand}</option>
                  ))}
                </select>
                {selectedBrands.size > 0 && (
                  <button
                    onClick={() => setSelectedBrands(new Set())}
                    className="mt-1 text-xs text-blue-400 hover:text-blue-300"
                  >
                    Clear ({selectedBrands.size})
                  </button>
                )}
              </div>
              
              {/* Type Multiselect */}
              <div>
                <label className="block text-gray-300 text-sm font-bold mb-1">Type</label>
                <select
                  multiple
                  value={Array.from(selectedTypes)}
                  onChange={(e) => {
                    const newSelected = new Set(Array.from(e.target.selectedOptions, option => option.value));
                    setSelectedTypes(newSelected);
                  }}
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded border border-gray-600 focus:outline-none focus:border-blue-500 min-h-[100px]"
                  size={5}
                >
                  {availableTypes.map(type => (
                    <option key={type} value={type}>
                      {INV_TYPES[type] || type}
                    </option>
                  ))}
                </select>
                {selectedTypes.size > 0 && (
                  <button
                    onClick={() => setSelectedTypes(new Set())}
                    className="mt-1 text-xs text-blue-400 hover:text-blue-300"
                  >
                    Clear ({selectedTypes.size})
                  </button>
                )}
              </div>
              
              {/* Has Image/Video Checkboxes */}
              <div className="space-y-2">
                <label className="block text-gray-300 text-sm font-bold mb-1">Media</label>
                <div className="space-y-2">
                  <label className="flex items-center text-gray-300 text-sm">
                    <input
                      type="checkbox"
                      checked={hasImage}
                      onChange={(e) => setHasImage(e.target.checked)}
                      className="mr-2"
                    />
                    Has Image
                  </label>
                  <label className="flex items-center text-gray-300 text-sm">
                    <input
                      type="checkbox"
                      checked={hasVideo}
                      onChange={(e) => setHasVideo(e.target.checked)}
                      className="mr-2"
                    />
                    Has Video
                  </label>
                </div>
              </div>
              
              {/* Legacy Type Filter (for backward compatibility) */}
              <div>
                <label className="block text-gray-300 text-sm font-bold mb-1">Legacy Type Filter</label>
                <select
                  value={filterType}
                  onChange={(e) => setFilterType(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded border border-gray-600 focus:outline-none focus:border-blue-500"
                >
                  <option value="">All Types</option>
                  {Object.keys(INV_TYPES).map(type => (
                    <option key={type} value={type}>{INV_TYPES[type]}</option>
                  ))}
                </select>
              </div>
            </div>
              </div>
            )}
          </div>

          {/* Loading/Error States */}
          {loading && (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-gray-400">Loading catalog...</p>
            </div>
          )}

          {catalogNotFound && !loading && (
            <div className="flex-1 flex flex-col items-center justify-center p-8">
              <div className="text-center max-w-md">
                <p className="text-gray-300 text-lg mb-2">Catalog Not Found</p>
                <p className="text-gray-400 text-sm mb-6">
                  The catalog file hasn't been created yet. Click the button below to fetch the latest data from backyard-hero.com.
                </p>
                <button
                  onClick={handleRefreshCatalog}
                  disabled={refreshingCatalog}
                  className="px-6 py-3 bg-green-900 hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded font-semibold"
                >
                  {refreshingCatalog ? 'Refreshing...' : 'Refresh Catalog'}
                </button>
              </div>
            </div>
          )}

          {error && !catalogNotFound && (
            <div className="flex-1 flex flex-col items-center justify-center p-8">
              <p className="text-red-400 text-center">{error}</p>
            </div>
          )}

          {/* Items List */}
          {!loading && !error && (
            <>
              <div className="mb-4 flex items-center justify-between">
                <div className="text-gray-300">
                  Showing {importableItems.length} items
                  {selectedItems.size > 0 && ` (${selectedItems.size} selected)`}
                </div>
                <button
                  onClick={handleSelectAll}
                  className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded"
                >
                  {selectedItems.size === importableItems.length ? 'Deselect All' : 'Select All'}
                </button>
              </div>

              <div className="flex-1 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-700 sticky top-0">
                    <tr>
                      <th className="px-4 py-2 text-left">
                        <input
                          type="checkbox"
                          checked={selectedItems.size === importableItems.length && importableItems.length > 0}
                          onChange={handleSelectAll}
                          className="mr-2"
                        />
                      </th>
                      <th 
                        className="px-4 py-2 text-left cursor-pointer hover:bg-gray-600"
                        onClick={() => handleSort('name')}
                      >
                        Name {sortColumn === 'name' && (sortDirection === 'asc' ? '↑' : '↓')}
                      </th>
                      <th 
                        className="px-4 py-2 text-left cursor-pointer hover:bg-gray-600"
                        onClick={() => handleSort('brand')}
                      >
                        Brand {sortColumn === 'brand' && (sortDirection === 'asc' ? '↑' : '↓')}
                      </th>
                      <th className="px-4 py-2 text-left">Original Type</th>
                      <th className="px-4 py-2 text-left">Mapped Type</th>
                      <th className="px-4 py-2 text-left">Duration</th>
                      <th className="px-4 py-2 text-left">Has Video</th>
                      <th className="px-4 py-2 text-left">Has Image</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importableItems.map((item, index) => (
                      <tr
                        key={`${item.name}-${item.brand}-${item.type}-${index}`}
                        className={`border-b border-gray-700 hover:bg-gray-700 ${
                          selectedItems.has(index) ? 'bg-gray-700' : ''
                        }`}
                      >
                        <td className="px-4 py-2">
                          <input
                            type="checkbox"
                            checked={selectedItems.has(index)}
                            onChange={() => handleToggleItem(index)}
                          />
                        </td>
                        <td className="px-4 py-2 text-white">{item.name}</td>
                        <td className="px-4 py-2 text-gray-300">{item.brand || '-'}</td>
                        <td className="px-4 py-2 text-gray-400">{item.originalType}</td>
                        <td className="px-4 py-2 text-blue-400" title={item.type || 'Unknown'}>
                          {item.type ? (INV_TYPES[item.type] || item.type.replace(/_/g, ' ')) : 'Unknown'}
                        </td>
                        <td className="px-4 py-2 text-gray-300">{item.duration ? `${item.duration}s` : '-'}</td>
                        <td className="px-4 py-2 text-gray-300">{item.video ? '✓' : '-'}</td>
                        <td className="px-4 py-2 text-gray-300">{item.image ? '✓' : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-gray-700 flex justify-end gap-4">
          <button
            onClick={onClose}
            disabled={importing}
            className="px-6 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleImport}
            disabled={importing || selectedItems.size === 0}
            className="px-6 py-2 bg-blue-900 hover:bg-blue-700 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {importing ? 'Importing...' : `Import ${selectedItems.size} Item(s)`}
          </button>
        </div>
      </div>
    </div>
  );
}

