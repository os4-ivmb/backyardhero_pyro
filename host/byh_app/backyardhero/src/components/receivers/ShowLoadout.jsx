import useAppStore from "@/store/useAppStore"
import useStateAppStore from "@/store/useStateAppStore";
import { useEffect, useRef, useState } from "react";
import { MdDownload, MdPrint, MdArrowBack, MdSave } from 'react-icons/md';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import SpatialLayoutMap from '../builder/SpatialLayoutMap';

function ShowLoadout({ setCurrentTab }) {
  const { systemConfig, stagedShow, updateShow } = useAppStore();
  const { stateData } = useStateAppStore();
  const [targetRcvMap, setTargetRcvMap] = useState({});
  const [receivers, setReceivers] = useState([]);
  const [receiverLocations, setReceiverLocations] = useState({});
  const [receiverNames, setReceiverNames] = useState({});
  const loadoutRef = useRef(null);

  useEffect(() => {
    let receiversTmp = systemConfig?.receivers || {};

    if (receiversTmp) {
      if (stateData.fw_state?.receivers) {
        receiversTmp = stateData.fw_state?.receivers;
      }

      // Build a lookup table for zones and targets to receivers
      const lookupTable = {};
      Object.keys(receiversTmp).forEach((receiverKey) => {
        const receiver = receiversTmp[receiverKey];
        Object.keys(receiver.cues).forEach((zoneKey) => {
          receiver.cues[zoneKey].forEach((target) => {
            lookupTable[`${zoneKey}:${target}`] = receiverKey;
          });
        });
      });

      // If stagedShow exists, process display_payload and filter receivers
      if (stagedShow?.items) {
        const map = {};
        const parsedPayload = JSON.parse(stagedShow.display_payload);

        stagedShow.items.forEach((payloadItem) => {
          const { itemId, zone, target } = payloadItem;

          const receiverKey = lookupTable[`${zone}:${target}`];
          if (receiverKey) {
            if (!map[receiverKey]) {
              map[receiverKey] = {};
            }

            if (!map[receiverKey][zone]) {
              map[receiverKey][zone] = {};
            }

            map[receiverKey][zone][target] = payloadItem;
          }
        });
        setTargetRcvMap(map);

        // Filter receivers to only include those that have items assigned
        const filteredReceivers = {};
        Object.keys(receiversTmp).forEach((receiverKey) => {
          const receiver = receiversTmp[receiverKey];
          const hasAssignedItems = map[receiverKey] && Object.keys(map[receiverKey]).length > 0;
          
          if (hasAssignedItems) {
            filteredReceivers[receiverKey] = receiver;
          }
        });

        setReceivers(filteredReceivers);

        // Load existing receiver locations from show data
        if (stagedShow.receiver_locations) {
          try {
            const parsedLocations = JSON.parse(stagedShow.receiver_locations);
            setReceiverLocations(parsedLocations);
          } catch (e) {
            console.error('Failed to parse receiver_locations for show:', stagedShow.id, e);
            // Initialize with default positions if parsing fails
            const defaultLocations = {};
            const receiverKeys = Object.keys(filteredReceivers);
            receiverKeys.forEach((receiverKey, index) => {
              const row = Math.floor(index / 3);
              const col = index % 3;
              defaultLocations[receiverKey] = {
                x: 100 + col * 150,
                y: 100 + row * 150
              };
            });
            setReceiverLocations(defaultLocations);
          }
        } else {
          // Initialize with default positions in a grid
          const defaultLocations = {};
          const receiverKeys = Object.keys(filteredReceivers);
          receiverKeys.forEach((receiverKey, index) => {
            const row = Math.floor(index / 3);
            const col = index % 3;
            defaultLocations[receiverKey] = {
              x: 100 + col * 150,
              y: 100 + row * 150
            };
          });
          setReceiverLocations(defaultLocations);
        }
      } else {
        setTargetRcvMap({});
        setReceivers({});
        setReceiverLocations({});
      }
    }
  }, [systemConfig.receivers, stagedShow, stateData.fw_state?.active_protocol, stateData.fw_state?.receivers]);

  // Function to arrange cues in the specified order
  const arrangeCuesInOrder = (cues) => {
    if (!cues || cues.length === 0) return [];
    
    const arrangedCues = [];
    const cueNumbers = cues.map(cue => parseInt(cue)).sort((a, b) => a - b);
    
    // Group cues into sets of 8
    for (let i = 0; i < cueNumbers.length; i += 8) {
      const set = cueNumbers.slice(i, i + 8);
      const arrangedSet = [];
      
      // For each set of 8, arrange as: 8,7,6,5,1,2,3,4
      if (set.length >= 5) {
        arrangedSet.push(set[7], set[6], set[5], set[4], set[0], set[1], set[2], set[3]);
      } else {
        // If less than 8 cues, just use the available ones
        arrangedSet.push(...set);
      }
      
      arrangedCues.push(...arrangedSet.filter(cue => cue !== undefined));
    }
    
    return arrangedCues;
  };

  // Function to get all items with pictures and their counts
  const getItemsWithPictures = () => {
    if (!stagedShow?.items) return [];
    
    const itemCounts = {};
    
    stagedShow.items.forEach((item) => {
      if (item.image) {
        const key = `${item.name}-${item.type}`;
        if (!itemCounts[key]) {
          itemCounts[key] = {
            ...item,
            count: 0
          };
        }
        itemCounts[key].count += 1;
      }
    });
    
    return Object.values(itemCounts).sort((a, b) => a.name.localeCompare(b.name));
  };

  // Save receiver locations to show data
  const saveReceiverLocations = async () => {
    if (!stagedShow.id) {
      alert("Please save the show first before saving receiver locations.");
      return;
    }

    try {
      const updatedShowData = {
        ...stagedShow,
        receiver_locations: receiverLocations
      };
      
      await updateShow(stagedShow.id, updatedShowData);
      alert("Receiver locations saved successfully!");
    } catch (error) {
      console.error('Failed to save receiver locations:', error);
      alert("Failed to save receiver locations. Please try again.");
    }
  };

  const exportToPDF = async () => {
    if (!loadoutRef.current) return;

    try {
      const pdf = new jsPDF('p', 'mm', 'a4');
      const pageWidth = 190; // A4 width minus margins
      const pageHeight = 277; // A4 height minus margins
      let currentY = 10; // Starting Y position

      // Function to create a temporary container for a section
      const createSectionContainer = (sectionElement) => {
        const tempContainer = document.createElement('div');
        tempContainer.style.position = 'absolute';
        tempContainer.style.left = '-9999px';
        tempContainer.style.top = '0';
        tempContainer.style.width = '800px';
        tempContainer.style.backgroundColor = '#ffffff';
        tempContainer.style.padding = '20px';
        tempContainer.style.fontFamily = 'Arial, sans-serif';
        tempContainer.style.color = '#000000';
        
        // Clone the section
        const sectionClone = sectionElement.cloneNode(true);
        
        // Convert dark theme to light theme for PDF
        const convertToLightTheme = (element) => {
          // Convert background colors
          if (element.style.backgroundColor === 'rgb(17, 24, 39)' || element.classList.contains('bg-gray-900')) {
            element.style.backgroundColor = '#ffffff';
          }
          if (element.classList.contains('bg-gray-800')) {
            element.style.backgroundColor = '#f8f9fa';
          }
          if (element.classList.contains('bg-gray-700')) {
            element.style.backgroundColor = '#e9ecef';
          }
          if (element.classList.contains('bg-blue-600')) {
            element.style.backgroundColor = '#007bff';
          }
          
          // Convert text colors
          if (element.classList.contains('text-gray-100')) {
            element.style.color = '#000000';
          }
          if (element.classList.contains('text-gray-200')) {
            element.style.color = '#495057';
          }
          if (element.classList.contains('text-gray-400')) {
            element.style.color = '#6c757d';
          }
          if (element.classList.contains('text-gray-500')) {
            element.style.color = '#6c757d';
          }
          if (element.classList.contains('text-white')) {
            element.style.color = '#ffffff';
          }
          
          // Convert border colors
          if (element.classList.contains('border-gray-600')) {
            element.style.borderColor = '#dee2e6';
          }
          
          // Recursively process child elements
          Array.from(element.children).forEach(convertToLightTheme);
        };
        
        convertToLightTheme(sectionClone);
        tempContainer.appendChild(sectionClone);
        return tempContainer;
      };

      // Function to add a section to PDF
      const addSectionToPDF = async (sectionElement, startNewPage = false) => {
        if (startNewPage) {
          pdf.addPage();
          currentY = 10;
        }

        const tempContainer = createSectionContainer(sectionElement);
        document.body.appendChild(tempContainer);

        const canvas = await html2canvas(tempContainer, {
          scale: 2,
          useCORS: true,
          allowTaint: true,
          backgroundColor: '#ffffff',
          width: 800,
          height: tempContainer.scrollHeight
        });

        document.body.removeChild(tempContainer);

        const imgData = canvas.toDataURL('image/png');
        const imgHeight = (canvas.height * pageWidth) / canvas.width;
        
        // Check if content fits on current page
        if (currentY + imgHeight > pageHeight) {
          pdf.addPage();
          currentY = 10;
        }

        pdf.addImage(imgData, 'PNG', 10, currentY, pageWidth, imgHeight);
        currentY += imgHeight + 10;
      };

      // Get all sections
      const loadoutContent = loadoutRef.current;
      const sections = loadoutContent.children;

      // Process each section
      for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        const shouldStartNewPage = section.classList.contains('page-break-before-always');
        
        // Skip the spatial layout section for PDF export
        const isSpatialLayout = section.textContent.includes('Spatial Layout');
        if (isSpatialLayout) {
          continue;
        }
        
        await addSectionToPDF(section, shouldStartNewPage);
      }

      const showName = stagedShow?.name || 'Show Loadout';
      pdf.save(`${showName.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_loadout.pdf`);
    } catch (error) {
      console.error('Error generating PDF:', error);
      alert('Error generating PDF. Please try again.');
    }
  };

  const printLoadout = () => {
    window.print();
  };

  if (!stagedShow) {
    return (
      <div className="w-full p-8 text-center">
        <h2 className="text-2xl font-bold text-gray-700 mb-4">Show Loadout</h2>
        <p className="text-gray-500">No show is currently staged. Please stage a show to view the loadout.</p>
      </div>
    );
  }

  return (
    <div className="w-full p-4">
      {/* Header */}
      <div className="flex justify-between items-center mb-6 print:hidden">
        <div className="flex items-center gap-4">
          <button
            onClick={() => setCurrentTab('receivers')}
            className="flex items-center gap-2 px-3 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors"
          >
            <MdArrowBack />
            Back to Receivers
          </button>
          <div>
            <h1 className="text-3xl font-bold text-gray-800">Show Loadout</h1>
            <p className="text-gray-600 mt-1">{stagedShow.name}</p>
          </div>
        </div>
        <div className="flex gap-3">
          <button
            onClick={printLoadout}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            <MdPrint />
            Print
          </button>
          <button
            onClick={exportToPDF}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
          >
            <MdDownload />
            Export PDF
          </button>
        </div>
      </div>

      {/* Print Header */}
      <div className="hidden print:block mb-6">
        <h1 className="text-3xl font-bold text-gray-800">{stagedShow.name} - Loadout</h1>
        <p className="text-gray-600">Generated on {new Date().toISOString().split('T')[0]}</p>
      </div>

      {/* Loadout Content */}
      <div ref={loadoutRef} className="bg-gray-900">
        {Object.keys(receivers).map((rcv_key, receiverIndex) => {
          const receiver = receivers[rcv_key];
          const receiverMapping = targetRcvMap[rcv_key];
          const firstZone = Object.keys(receiver.cues)[0];
          const cues = receiver.cues[firstZone] || [];
          
          // Only render if there are cues
          if (cues.length === 0) return null;
          
          const arrangedCues = arrangeCuesInOrder(cues);

          return (
            <div key={rcv_key} className="mb-8 page-break-inside-avoid">
              {/* Receiver Header */}
              <div className="border-b-2 border-gray-600 pb-2 mb-4">
                <input
                  type="text"
                  value={receiverNames[rcv_key] || rcv_key}
                  onChange={(e) => setReceiverNames(prev => ({
                    ...prev,
                    [rcv_key]: e.target.value
                  }))}
                  className="text-2xl font-bold text-gray-100 bg-transparent border-none outline-none focus:ring-2 focus:ring-blue-500 rounded px-1"
                  placeholder={rcv_key}
                />
                <p className="text-gray-400">Zone: {firstZone}</p>
              </div>

              {/* 2x4 Grid for Cues */}
              <div className="grid grid-cols-4 gap-4">
                {arrangedCues.map((target, cueIndex) => {
                  const item = receiverMapping?.[firstZone]?.[target];
                  
                  return (
                    <div
                      key={cueIndex}
                      className="border-2 border-gray-600 rounded-lg p-4 min-h-[200px] flex flex-col bg-gray-800"
                    >
                      {/* Cue Number */}
                      <div className="text-center mb-3">
                        <span className="bg-gray-700 text-gray-200 px-3 py-1 rounded-full text-sm font-semibold">
                          Cue {target}
                        </span>
                      </div>

                      {/* Item Content */}
                      <div className="flex-1 flex flex-col items-center justify-center text-center">
                        {item ? (
                          <>
                            {/* Item Image */}
                            {item.image && (
                              <div className="mb-3">
                                <img
                                  src={item.image}
                                  alt={item.name}
                                  className="w-16 h-16 object-cover rounded-lg border border-gray-600"
                                />
                              </div>
                            )}
                            
                            {/* Item Name */}
                            <h3 className="font-semibold text-gray-100 mb-1 text-lg">
                              {item.name}
                            </h3>
                            
                            {/* Item Type */}
                            <p className="text-gray-400 text-sm mb-2">
                              Type: {item.type}
                            </p>
                            
                            {/* Item Duration */}
                            {item.duration && (
                              <p className="text-gray-400 text-sm">
                                Duration: {item.duration}s
                              </p>
                            )}
                          </>
                        ) : (
                          <div className="text-gray-500 italic">
                            <p>No item assigned</p>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* Items with Pictures Section */}
        {(() => {
          const itemsWithPictures = getItemsWithPictures();
          if (itemsWithPictures.length === 0) return null;
          
          return (
            <div className="mt-8 page-break-inside-avoid page-break-before-always">
              <div className="border-b-2 border-gray-600 pb-2 mb-4">
                <h2 className="text-2xl font-bold text-gray-100">Items to Pack</h2>
                <p className="text-gray-400">All items with pictures and their counts</p>
              </div>
              
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {itemsWithPictures.map((item, index) => (
                  <div
                    key={index}
                    className="border-2 border-gray-600 rounded-lg p-4 bg-gray-800 flex flex-col items-center"
                  >
                    {/* Item Image */}
                    <div className="mb-3">
                      <img
                        src={item.image}
                        alt={item.name}
                        className="w-20 h-20 object-cover rounded-lg border border-gray-600"
                      />
                    </div>
                    
                    {/* Item Name */}
                    <h3 className="font-semibold text-gray-100 mb-1 text-center text-sm">
                      {item.name}
                    </h3>
                    
                    {/* Item Type */}
                    <p className="text-gray-400 text-xs mb-2 text-center">
                      {item.type}
                    </p>
                    
                    {/* Count Badge */}
                    <div className="bg-blue-600 text-white px-3 py-1 rounded-full text-sm font-bold">
                      Count: {item.count}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {/* Spatial Layout Section */}
        {Object.keys(receivers).length > 0 && (
          <div className="mt-8 page-break-inside-avoid page-break-before-always">
            <div className="border-b-2 border-gray-600 pb-2 mb-4">
              <h2 className="text-2xl font-bold text-gray-100">Spatial Layout</h2>
              <p className="text-gray-400">Receiver positions and item locations</p>
            </div>
            <SpatialLayoutMap
              receivers={receivers}
              items={stagedShow?.items || []}
              receiverLocations={receiverLocations}
              setReceiverLocations={setReceiverLocations}
              onSaveLocations={saveReceiverLocations}
              showSaveButton={true}
            />
          </div>
        )}
      </div>

      {/* Print Styles */}
      <style jsx>{`
        @media print {
          .page-break-inside-avoid {
            page-break-inside: avoid;
          }
          
          .page-break-before-always {
            page-break-before: always;
          }
          
          @page {
            margin: 1in;
          }
        }
      `}</style>
    </div>
  );
}

export default ShowLoadout; 