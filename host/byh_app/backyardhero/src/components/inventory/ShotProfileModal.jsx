import React, { useState, useEffect } from "react";
import axios from "axios";
import { MdRefresh, MdAdd, MdDelete, MdSave } from "react-icons/md";
import useAppStore from '@/store/useAppStore';

export default function ShotProfileModal({ isVisible, item, firingProfile, onClose, onReprocessComplete }) {
  const { updateInventoryItem } = useAppStore();
  const [isReprocessing, setIsReprocessing] = useState(false);
  const [reprocessStatus, setReprocessStatus] = useState(null);
  const [detectionMethod, setDetectionMethod] = useState('max_amplitude');
  const [thresholdRatio, setThresholdRatio] = useState(0.70);
  const [thresholdRatioInput, setThresholdRatioInput] = useState('0.70');
  const [floorPercent, setFloorPercent] = useState(10.0);
  const [floorPercentInput, setFloorPercentInput] = useState('10.0');
  const [mergeThresholdMs, setMergeThresholdMs] = useState(500);
  const [mergeThresholdMsInput, setMergeThresholdMsInput] = useState('500');
  const [overrideDuration, setOverrideDuration] = useState(false);
  const [showReprocessOptions, setShowReprocessOptions] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  
  // Editor state
  const [editableShots, setEditableShots] = useState([]);
  const [selectedShotIndex, setSelectedShotIndex] = useState(null);
  const [offsetSeconds, setOffsetSeconds] = useState(0);
  const [offsetSecondsInput, setOffsetSecondsInput] = useState('0');
  const [durationInput, setDurationInput] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  // Normalize shots to [start, end, color] format
  const normalizeShots = (shots) => {
    if (!shots) return [];
    return shots.map(shot => {
      if (Array.isArray(shot)) {
        if (shot.length === 2) {
          return [shot[0], shot[1], null];
        } else if (shot.length >= 3) {
          return [shot[0], shot[1], shot[2] || null];
        }
      }
      return shot;
    });
  };

  // Initialize editor state when profile changes
  useEffect(() => {
    if (firingProfile && firingProfile.shot_timestamps) {
      const normalized = normalizeShots(firingProfile.shot_timestamps);
      setEditableShots(normalized);
      setHasChanges(false);
      
      // Initialize duration input
      const totalDuration = normalized.length > 0 
        ? Math.max(...normalized.map(shot => shot[1])) 
        : 0;
      setDurationInput((totalDuration / 1000).toFixed(2));
    }
  }, [firingProfile]);

  // Initialize duration from item
  useEffect(() => {
    if (item?.duration) {
      setDurationInput(item.duration.toString());
    }
  }, [item]);

  if (!isVisible || !item) return null;

  const hasYouTubeLink = item.youtube_link && item.youtube_link.trim() !== '' && item.youtube_link_start_sec !== null;

  const handleReprocess = async () => {
    if (!item?.id || !hasYouTubeLink) return;

    setIsReprocessing(true);
    setReprocessStatus(null);

    try {
      const response = await axios.post(`/api/inventory/${item.id}/reprocess-profile`, {
        detectionMethod: detectionMethod,
        thresholdRatio: detectionMethod === 'max_amplitude' ? thresholdRatio : undefined,
        floorPercent: detectionMethod === 'noise_floor' ? floorPercent : undefined,
        mergeThresholdMs: mergeThresholdMs,
        overrideDuration: overrideDuration
      });
      
      setReprocessStatus({
        success: true,
        message: response.data.message || 'Reprocessing started. This may take a few minutes. Please refresh to see the updated profile.'
      });

      if (onReprocessComplete) {
        setTimeout(() => {
          onReprocessComplete();
        }, 2000);
      }
    } catch (error) {
      console.error('Error reprocessing profile:', error);
      setReprocessStatus({
        success: false,
        message: error.response?.data?.error || 'Failed to start reprocessing. Please try again.'
      });
    } finally {
      setIsReprocessing(false);
    }
  };

  const handleRefresh = async () => {
    if (!item?.id || !onReprocessComplete) return;
    setIsRefreshing(true);
    try {
      await onReprocessComplete();
    } catch (error) {
      console.error('Error refreshing profile:', error);
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleOffsetShots = () => {
    const offsetMs = parseFloat(offsetSecondsInput) * 1000;
    if (isNaN(offsetMs)) return;

    const updatedShots = editableShots.map(shot => [
      Math.max(0, shot[0] + offsetMs),
      Math.max(0, shot[1] + offsetMs),
      shot[2]
    ]);
    
    setEditableShots(updatedShots);
    setHasChanges(true);
    setOffsetSecondsInput('0');
  };

  const handleAddShot = () => {
    const totalDuration = editableShots.length > 0 
      ? Math.max(...editableShots.map(shot => shot[1])) 
      : 0;
    
    const newShot = [totalDuration, totalDuration + 1000, null]; // 1 second default
    setEditableShots([...editableShots, newShot]);
    setHasChanges(true);
    setSelectedShotIndex(editableShots.length);
  };

  const handleRemoveShot = (index) => {
    const updated = editableShots.filter((_, i) => i !== index);
    setEditableShots(updated);
    setHasChanges(true);
    if (selectedShotIndex === index) {
      setSelectedShotIndex(null);
    } else if (selectedShotIndex > index) {
      setSelectedShotIndex(selectedShotIndex - 1);
    }
  };

  const handleUpdateShot = (index, field, value) => {
    const updated = [...editableShots];
    if (field === 'start') {
      updated[index][0] = Math.max(0, parseInt(value) || 0);
    } else if (field === 'end') {
      updated[index][1] = Math.max(updated[index][0], parseInt(value) || updated[index][0]);
    }
    setEditableShots(updated);
    setHasChanges(true);
  };

  const handleShotColorChange = (index, color) => {
    const updated = [...editableShots];
    updated[index][2] = color || null;
    setEditableShots(updated);
    setHasChanges(true);
  };

  const handleSave = async () => {
    if (!item?.id) return;

    setIsSaving(true);
    try {
      // Save firing profile
      await axios.patch(`/api/inventory/${item.id}/firing-profile`, {
        shot_timestamps: editableShots
      });

      // Save duration if changed
      const durationValue = parseFloat(durationInput);
      if (!isNaN(durationValue) && durationValue !== item.duration) {
        await updateInventoryItem(item.id, { duration: durationValue });
      }

      setHasChanges(false);
      
      // Refresh profile
      if (onReprocessComplete) {
        await onReprocessComplete();
      }
    } catch (error) {
      console.error('Error saving profile:', error);
      alert('Failed to save profile. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  // If no profile exists, show generation UI
  if (!firingProfile || !firingProfile.shot_timestamps) {
    return (
      <div 
        className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
        onClick={onClose}
      >
        <div 
          className="bg-gray-800 rounded-lg p-6 max-w-2xl w-full mx-4"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-2xl font-bold text-white">
              Shot Profile: {item?.name || 'Unknown'}
            </h2>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-white text-3xl leading-none"
            >
              &times;
            </button>
          </div>

          <div className="mb-4 text-gray-300">
            {hasYouTubeLink ? (
              <>
                <p className="mb-4">No firing profile found for this item.</p>
                <p className="mb-4 text-sm text-gray-400">
                  This item has a YouTube link configured. You can generate a firing profile by processing the video.
                </p>
                
                <div className="flex justify-end">
                  <div className="flex flex-col items-end gap-2">
                    <button
                      onClick={() => setShowReprocessOptions(!showReprocessOptions)}
                      className="text-blue-400 hover:text-blue-300 text-sm underline"
                    >
                      {showReprocessOptions ? 'Hide' : 'Show'} Advanced Options
                    </button>
                    
                    {showReprocessOptions && (
                      <div className="bg-gray-700 rounded p-3 w-80">
                        <div className="mb-3">
                          <label className="block text-gray-200 text-sm font-bold mb-2">
                            Detection Method
                          </label>
                          <select
                            value={detectionMethod}
                            onChange={(e) => setDetectionMethod(e.target.value)}
                            className="shadow appearance-none border rounded w-full py-2 px-3 text-white bg-gray-800 border-gray-600 leading-tight focus:outline-none focus:shadow-outline"
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
                                className="shadow appearance-none border rounded w-full py-2 px-3 text-white bg-gray-800 border-gray-600 leading-tight focus:outline-none focus:shadow-outline"
                              />
                              <p className="text-gray-400 text-xs italic mt-1">
                                Lower = more sensitive
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
                                className="shadow appearance-none border rounded w-full py-2 px-3 text-white bg-gray-800 border-gray-600 leading-tight focus:outline-none focus:shadow-outline"
                              />
                              <p className="text-gray-400 text-xs italic mt-1">
                                % above noise floor
                              </p>
                            </div>
                          )}
                          <div className="flex-1">
                            <label className="block text-gray-200 text-sm font-bold mb-2">
                              Merge (ms)
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
                              className="shadow appearance-none border rounded w-full py-2 px-3 text-white bg-gray-800 border-gray-600 leading-tight focus:outline-none focus:shadow-outline"
                            />
                            <p className="text-gray-400 text-xs italic mt-1">
                              Gap to merge shots
                            </p>
                          </div>
                        </div>
                      </div>
                    )}

                    <button
                      onClick={handleReprocess}
                      disabled={isReprocessing}
                      className="bg-blue-900 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline"
                    >
                      {isReprocessing ? 'Processing...' : 'Generate Firing Profile'}
                    </button>
                  </div>
                </div>
                
                {reprocessStatus && (
                  <p className={`mt-2 text-sm ${reprocessStatus.success ? 'text-green-400' : 'text-red-400'}`}>
                    {reprocessStatus.message}
                  </p>
                )}
              </>
            ) : (
              <p>No firing profile available. This item needs a YouTube link and start time to generate a profile.</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  const totalDuration = editableShots.length > 0 
    ? Math.max(...editableShots.map(shot => shot[1])) 
    : 0;

  return (
    <div 
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 overflow-y-auto"
      onClick={onClose}
    >
      <div 
        className="bg-gray-800 rounded-lg p-6 max-w-6xl w-full mx-4 my-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-2xl font-bold text-white">
            Shot Profile Editor: {item?.name || 'Unknown'}
          </h2>
          <div className="flex items-center gap-2">
            {hasChanges && (
              <span className="text-yellow-400 text-sm">Unsaved changes</span>
            )}
            <button
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="text-gray-400 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed p-1"
              title="Refresh Profile"
            >
              <MdRefresh className={`text-2xl ${isRefreshing ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-white text-3xl leading-none"
            >
              &times;
            </button>
          </div>
        </div>

        {/* Editor Controls */}
        <div className="mb-4 bg-gray-700 rounded p-4 space-y-3">
          <div className="flex gap-4 items-end">
            <div className="flex-1">
              <label className="block text-gray-200 text-sm font-bold mb-2">
                Duration (seconds)
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={durationInput}
                onChange={(e) => setDurationInput(e.target.value)}
                onBlur={(e) => {
                  const val = parseFloat(e.target.value);
                  if (isNaN(val) || val < 0) {
                    setDurationInput(item.duration?.toString() || '0');
                  }
                }}
                className="shadow appearance-none border rounded w-full py-2 px-3 text-white bg-gray-800 border-gray-600 leading-tight focus:outline-none focus:shadow-outline"
              />
            </div>
            
            <div className="flex-1">
              <label className="block text-gray-200 text-sm font-bold mb-2">
                Offset All Shots (seconds)
              </label>
              <div className="flex gap-2">
                <input
                  type="number"
                  step="0.01"
                  value={offsetSecondsInput}
                  onChange={(e) => {
                    const val = e.target.value;
                    setOffsetSecondsInput(val);
                    const num = parseFloat(val);
                    if (!isNaN(num)) {
                      setOffsetSeconds(num);
                    }
                  }}
                  onBlur={(e) => {
                    const val = e.target.value;
                    const num = parseFloat(val);
                    if (val === '' || isNaN(num)) {
                      setOffsetSecondsInput('0');
                    }
                  }}
                  className="shadow appearance-none border rounded flex-1 py-2 px-3 text-white bg-gray-800 border-gray-600 leading-tight focus:outline-none focus:shadow-outline"
                  placeholder="±0.00"
                />
                <button
                  onClick={handleOffsetShots}
                  className="bg-blue-900 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline"
                >
                  Apply
                </button>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleAddShot}
                className="bg-green-900 hover:bg-green-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline flex items-center gap-2"
              >
                <MdAdd /> Add Shot
              </button>
              <button
                onClick={handleSave}
                disabled={isSaving || !hasChanges}
                className="bg-blue-900 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline flex items-center gap-2"
              >
                <MdSave /> {isSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>

          {/* Color Picker for Selected Shot */}
          {selectedShotIndex !== null && editableShots[selectedShotIndex] && (
            <div className="flex items-center gap-4 pt-2 border-t border-gray-600">
              <label className="text-gray-200 text-sm font-bold">
                Shot {selectedShotIndex + 1} Color:
              </label>
              <input
                type="color"
                value={editableShots[selectedShotIndex][2] || '#3B82F6'}
                onChange={(e) => handleShotColorChange(selectedShotIndex, e.target.value)}
                className="h-10 w-20 cursor-pointer"
              />
              <button
                onClick={() => handleShotColorChange(selectedShotIndex, null)}
                className="text-gray-400 hover:text-white text-sm underline"
              >
                Clear Color
              </button>
            </div>
          )}
        </div>

        {/* Timeline Container */}
        <div className="bg-gray-900 rounded p-4 mb-4">
          <div className="relative" style={{ height: '60px', width: '100%', minHeight: '60px' }}>
            <div className="absolute inset-0 border border-gray-600 rounded"></div>
            
            {editableShots.map((shot, index) => {
              const [start, end, color] = shot;
              const left = totalDuration > 0 ? (start / totalDuration) * 100 : 0;
              const width = totalDuration > 0 ? ((end - start) / totalDuration) * 100 : 0;
              const bgColor = color || '#3B82F6';
              const isSelected = selectedShotIndex === index;
              
              return (
                <div
                  key={index}
                  onClick={() => setSelectedShotIndex(index)}
                  className={`absolute rounded cursor-pointer border-2 transition-all ${
                    isSelected ? 'ring-2 ring-yellow-400 ring-offset-2' : ''
                  }`}
                  style={{
                    left: `${left}%`,
                    width: `${width}%`,
                    height: '40px',
                    top: '10px',
                    minWidth: '2px',
                    backgroundColor: bgColor,
                    borderColor: isSelected ? '#FBBF24' : bgColor,
                  }}
                  title={`Shot ${index + 1}: ${(start / 1000).toFixed(2)}s - ${(end / 1000).toFixed(2)}s (${((end - start) / 1000).toFixed(2)}s)`}
                />
              );
            })}
          </div>
          
          <div className="flex justify-between text-xs text-gray-500 mt-2">
            <span>0s</span>
            <span>{(totalDuration / 2000).toFixed(2)}s</span>
            <span>{(totalDuration / 1000).toFixed(2)}s</span>
          </div>
        </div>

        {/* Editable Shot List */}
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-sm text-gray-300">
            <thead>
              <tr className="border-b border-gray-700">
                <th className="text-left p-2">Shot</th>
                <th className="text-left p-2">Start (ms)</th>
                <th className="text-left p-2">End (ms)</th>
                <th className="text-left p-2">Duration (ms)</th>
                <th className="text-left p-2">Color</th>
                <th className="text-left p-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {editableShots.map((shot, index) => {
                const [start, end, color] = shot;
                const duration = end - start;
                const isSelected = selectedShotIndex === index;
                
                return (
                  <tr 
                    key={index} 
                    className={`border-b border-gray-700 hover:bg-gray-700 cursor-pointer ${
                      isSelected ? 'bg-gray-700' : ''
                    }`}
                    onClick={() => setSelectedShotIndex(index)}
                  >
                    <td className="p-2">{index + 1}</td>
                    <td className="p-2">
                      <input
                        type="number"
                        min="0"
                        value={start}
                        onChange={(e) => handleUpdateShot(index, 'start', e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        className="w-20 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white"
                      />
                    </td>
                    <td className="p-2">
                      <input
                        type="number"
                        min={start}
                        value={end}
                        onChange={(e) => handleUpdateShot(index, 'end', e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        className="w-20 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white"
                      />
                    </td>
                    <td className="p-2">{duration}</td>
                    <td className="p-2">
                      <div 
                        className="w-8 h-8 rounded border border-gray-600 inline-block"
                        style={{ backgroundColor: color || '#3B82F6' }}
                      />
                    </td>
                    <td className="p-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveShot(index);
                        }}
                        className="text-red-400 hover:text-red-300"
                        title="Remove Shot"
                      >
                        <MdDelete />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Reprocess Options (collapsed) */}
        {hasYouTubeLink && (
          <div className="mt-4 pt-4 border-t border-gray-700">
            <button
              onClick={() => setShowReprocessOptions(!showReprocessOptions)}
              className="text-blue-400 hover:text-blue-300 text-sm underline mb-2"
            >
              {showReprocessOptions ? 'Hide' : 'Show'} Reprocess Options
            </button>
            
            {showReprocessOptions && (
              <div className="bg-gray-700 rounded p-3 mt-2">
                <div className="mb-3">
                  <label className="block text-gray-200 text-sm font-bold mb-2">
                    Detection Method
                  </label>
                  <select
                    value={detectionMethod}
                    onChange={(e) => setDetectionMethod(e.target.value)}
                    className="shadow appearance-none border rounded w-full py-2 px-3 text-white bg-gray-800 border-gray-600 leading-tight focus:outline-none focus:shadow-outline"
                  >
                    <option value="max_amplitude">Max Amplitude</option>
                    <option value="noise_floor">Noise Floor</option>
                  </select>
                </div>
                <div className="flex gap-4 mb-3">
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
                        className="shadow appearance-none border rounded w-full py-2 px-3 text-white bg-gray-800 border-gray-600 leading-tight focus:outline-none focus:shadow-outline"
                      />
                      <p className="text-gray-400 text-xs italic mt-1">
                        Lower = more sensitive
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
                        className="shadow appearance-none border rounded w-full py-2 px-3 text-white bg-gray-800 border-gray-600 leading-tight focus:outline-none focus:shadow-outline"
                      />
                      <p className="text-gray-400 text-xs italic mt-1">
                        % above noise floor
                      </p>
                    </div>
                  )}
                  <div className="flex-1">
                    <label className="block text-gray-200 text-sm font-bold mb-2">
                      Merge (ms)
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
                      className="shadow appearance-none border rounded w-full py-2 px-3 text-white bg-gray-800 border-gray-600 leading-tight focus:outline-none focus:shadow-outline"
                    />
                    <p className="text-gray-400 text-xs italic mt-1">
                      Gap to merge shots
                    </p>
                  </div>
                </div>
                <div className="mb-3">
                  <label className="flex items-center gap-2 text-gray-200 text-sm">
                    <input
                      type="checkbox"
                      checked={overrideDuration}
                      onChange={(e) => setOverrideDuration(e.target.checked)}
                      className="w-4 h-4 text-blue-600 bg-gray-800 border-gray-600 rounded focus:ring-blue-500"
                    />
                    <span className="font-bold">Override Duration</span>
                  </label>
                  <p className="text-gray-400 text-xs italic mt-1 ml-6">
                    Set item duration from first shot start to last shot end
                  </p>
                </div>
                <button
                  onClick={handleReprocess}
                  disabled={isReprocessing}
                  className="bg-blue-900 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline"
                >
                  {isReprocessing ? 'Reprocessing...' : 'Reprocess Profile'}
                </button>
                {reprocessStatus && (
                  <p className={`mt-2 text-sm ${reprocessStatus.success ? 'text-green-400' : 'text-red-400'}`}>
                    {reprocessStatus.message}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
