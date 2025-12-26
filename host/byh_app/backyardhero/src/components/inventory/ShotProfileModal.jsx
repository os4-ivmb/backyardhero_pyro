import React from "react";

export default function ShotProfileModal({ isVisible, item, firingProfile, onClose }) {
  if (!isVisible || !firingProfile || !firingProfile.shot_timestamps) return null;

  const shots = firingProfile.shot_timestamps;
  
  // Calculate the total duration (end time of last shot)
  const totalDuration = shots.length > 0 
    ? Math.max(...shots.map(shot => shot[1])) 
    : 0;

  // Calculate scale factor for rendering (assuming max width of 800px)
  const maxWidth = 800;
  const scale = totalDuration > 0 ? maxWidth / totalDuration : 1;

  return (
    <div 
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div 
        className="bg-gray-800 rounded-lg p-6 max-w-4xl w-full mx-4"
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
          <p>Total Shots: {shots.length}</p>
          <p>Duration: {(totalDuration / 1000).toFixed(2)}s</p>
        </div>

        {/* Timeline Container */}
        <div className="bg-gray-900 rounded p-4 mb-4">
          <div className="relative" style={{ height: '60px', width: '100%', minHeight: '60px' }}>
            {/* Timeline background */}
            <div className="absolute inset-0 border border-gray-600 rounded"></div>
            
            {/* Shot bars */}
            {shots.map((shot, index) => {
              const [start, end] = shot;
              const left = (start / totalDuration) * 100;
              const width = ((end - start) / totalDuration) * 100;
              
              return (
                <div
                  key={index}
                  className="absolute bg-blue-500 hover:bg-blue-400 border border-blue-300 rounded"
                  style={{
                    left: `${left}%`,
                    width: `${width}%`,
                    height: '40px',
                    top: '10px',
                    minWidth: '2px', // Ensure very short shots are visible
                    transition: 'background-color 0.2s',
                  }}
                  title={`Shot ${index + 1}: ${(start / 1000).toFixed(2)}s - ${(end / 1000).toFixed(2)}s (${((end - start) / 1000).toFixed(2)}s)`}
                />
              );
            })}
          </div>
          
          {/* Time markers */}
          <div className="flex justify-between text-xs text-gray-500 mt-2">
            <span>0s</span>
            <span>{(totalDuration / 2000).toFixed(2)}s</span>
            <span>{(totalDuration / 1000).toFixed(2)}s</span>
          </div>
        </div>

        {/* Shot list */}
        <div className="max-h-64 overflow-y-auto">
          <table className="w-full text-sm text-gray-300">
            <thead>
              <tr className="border-b border-gray-700">
                <th className="text-left p-2">Shot</th>
                <th className="text-left p-2">Start (ms)</th>
                <th className="text-left p-2">End (ms)</th>
                <th className="text-left p-2">Duration (ms)</th>
              </tr>
            </thead>
            <tbody>
              {shots.map((shot, index) => {
                const [start, end] = shot;
                const duration = end - start;
                return (
                  <tr key={index} className="border-b border-gray-700 hover:bg-gray-700">
                    <td className="p-2">{index + 1}</td>
                    <td className="p-2">{start}</td>
                    <td className="p-2">{end}</td>
                    <td className="p-2">{duration}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

