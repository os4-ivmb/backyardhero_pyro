import useAppStore from "@/store/useAppStore"
import useStateAppStore from "@/store/useStateAppStore";
import { useEffect, useRef, useState } from "react";
import { MdDownload, MdPrint, MdArrowBack, MdSave } from 'react-icons/md';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import SpatialLayoutMap from '../builder/SpatialLayoutMap';
import axios from 'axios';

function ShowLoadout({ setCurrentTab }) {
  const { systemConfig, stagedShow, updateShow, inventory } = useAppStore();
  const { stateData } = useStateAppStore();
  const [targetRcvMap, setTargetRcvMap] = useState({});
  const [receivers, setReceivers] = useState([]);
  const [receiverLocations, setReceiverLocations] = useState({});
  const [receiverNames, setReceiverNames] = useState({});
  const [racks, setRacks] = useState([]);
  const [cellToItemMap, setCellToItemMap] = useState({}); // Maps cell keys to show items
  const loadoutRef = useRef(null);
  
  // Load receiver labels from show data
  useEffect(() => {
    if (stagedShow?.receiverLabels) {
      setReceiverNames(stagedShow.receiverLabels);
    } else if (stagedShow?.receiver_labels) {
      try {
        const parsedLabels = JSON.parse(stagedShow.receiver_labels);
        setReceiverNames(parsedLabels);
      } catch (e) {
        console.error('Failed to parse receiver_labels for show:', stagedShow.id, e);
      }
    }
  }, [stagedShow]);

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

  // Fetch racks for the show
  useEffect(() => {
    const fetchRacks = async () => {
      if (!stagedShow?.id) {
        console.log('No stagedShow.id, clearing racks');
        setRacks([]);
        return;
      }

      try {
        const showId = parseInt(stagedShow.id);
        console.log('Fetching racks for show_id:', showId, '(original:', stagedShow.id, ')');
        const response = await axios.get('/api/racks', { params: { show_id: showId } });
        console.log('Racks response:', response.data, 'count:', response.data?.length);
        setRacks(response.data || []);
      } catch (error) {
        console.error('Failed to fetch racks:', error);
        console.error('Error details:', error.response?.data || error.message);
        setRacks([]);
      }
    };

    fetchRacks();
  }, [stagedShow?.id]);

  // Build mapping from rack cells to show items and receivers/cues
  useEffect(() => {
    if (!stagedShow?.items || !racks.length) {
      setCellToItemMap({});
      return;
    }

    // Build lookup table for zones and targets to receivers
    let receiversTmp = systemConfig?.receivers || {};
    if (stateData.fw_state?.receivers) {
      receiversTmp = stateData.fw_state?.receivers;
    }

    const lookupTable = {};
    Object.keys(receiversTmp).forEach((receiverKey) => {
      const receiver = receiversTmp[receiverKey];
      Object.keys(receiver.cues).forEach((zoneKey) => {
        receiver.cues[zoneKey].forEach((target) => {
          lookupTable[`${zoneKey}:${target}`] = receiverKey;
        });
      });
    });

    // Map each rack cell to its show item and receiver/cue
    const cellMap = {};
    
    racks.forEach((rack) => {
      const cells = rack.cells || {};
      
      // Find all show items that use cells from this rack
      stagedShow.items.forEach((item) => {
        // Compare rackId as numbers to handle type mismatches
        const itemRackId = parseInt(item.rackId);
        const rackIdNum = parseInt(rack.id);
        
        if (item.type === 'RACK_SHELLS' && item.rackCells && itemRackId === rackIdNum) {
          const receiverKey = lookupTable[`${item.zone}:${item.target}`];
          
          console.log(`Found RACK_SHELLS item for rack ${rackIdNum}:`, item);
          console.log(`rackCells:`, item.rackCells);
          
          item.rackCells.forEach((cellKey) => {
            if (cells[cellKey]) {
              if (!cellMap[rack.id]) {
                cellMap[rack.id] = {};
              }
              cellMap[rack.id][cellKey] = {
                item,
                receiverKey,
                receiverName: receiverNames[receiverKey] || receiverKey,
                zone: item.zone,
                target: item.target
              };
              console.log(`Mapped cell ${cellKey} to receiver ${receiverKey}, zone ${item.zone}, target ${item.target}`);
            } else {
              console.log(`Cell ${cellKey} not found in rack cells`);
            }
          });
        }
      });
    });

    console.log('Cell to item map:', cellMap);
    setCellToItemMap(cellMap);
  }, [stagedShow?.items, racks, systemConfig?.receivers, stateData.fw_state?.receivers, receiverNames]);

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
        tempContainer.style.overflow = 'visible'; // Ensure content is not clipped
        tempContainer.style.minHeight = 'auto'; // Allow natural height
        
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
          // Convert blue backgrounds with opacity
          if (element.classList.contains('bg-blue-900')) {
            element.style.backgroundColor = '#e7f3ff';
          }
          
          // Convert text colors - ensure all text is dark/black for readability
          if (element.classList.contains('text-gray-100') || 
              element.classList.contains('text-gray-200') ||
              element.classList.contains('text-gray-300')) {
            element.style.color = '#000000';
          }
          if (element.classList.contains('text-gray-400') ||
              element.classList.contains('text-gray-500') ||
              element.classList.contains('text-gray-600')) {
            element.style.color = '#333333';
          }
          // Convert blue text colors to dark blue or black
          if (element.classList.contains('text-blue-200') ||
              element.classList.contains('text-blue-300') ||
              element.classList.contains('text-blue-400')) {
            element.style.color = '#000000';
          }
          if (element.classList.contains('text-blue-100')) {
            element.style.color = '#000000';
          }
          // Convert yellow text to dark colors
          if (element.classList.contains('text-yellow-300') ||
              element.classList.contains('text-yellow-400')) {
            element.style.color = '#856404';
          }
          // Keep white text only if it's on a dark background that we're converting
          if (element.classList.contains('text-white')) {
            // Check if parent has dark background - if so, make text black
            const hasDarkBg = element.closest('.bg-gray-900, .bg-gray-800, .bg-gray-700, .bg-blue-900');
            if (hasDarkBg) {
              element.style.color = '#000000';
            }
          }
          
          // Check inline style color if present
          if (element.style.color) {
            const color = element.style.color;
            const rgbMatch = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
            if (rgbMatch) {
              const r = parseInt(rgbMatch[1]);
              const g = parseInt(rgbMatch[2]);
              const b = parseInt(rgbMatch[3]);
              // If it's a light color (average > 200), make it black
              if ((r + g + b) / 3 > 200) {
                element.style.color = '#000000';
              }
            }
          }
          
          // Convert border colors
          if (element.classList.contains('border-gray-600') ||
              element.classList.contains('border-gray-700')) {
            element.style.borderColor = '#dee2e6';
          }
          if (element.classList.contains('border-blue-500')) {
            element.style.borderColor = '#007bff';
          }
          
          // Recursively process child elements
          Array.from(element.children).forEach(convertToLightTheme);
        };
        
        convertToLightTheme(sectionClone);
        tempContainer.appendChild(sectionClone);
        return tempContainer;
      };

      // Function to ensure all text is dark/black for readability
      const ensureDarkText = (container) => {
        const allElements = container.querySelectorAll('*');
        allElements.forEach((element) => {
          const computedStyle = window.getComputedStyle(element);
          const color = computedStyle.color;
          
          if (color) {
            const rgbMatch = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
            if (rgbMatch) {
              const r = parseInt(rgbMatch[1]);
              const g = parseInt(rgbMatch[2]);
              const b = parseInt(rgbMatch[3]);
              const avg = (r + g + b) / 3;
              
              // If it's a light color (average > 180), make it black or dark gray
              if (avg > 180) {
                // For very light colors (avg > 220), use black
                // For moderately light colors, use dark gray
                element.style.color = avg > 220 ? '#000000' : '#333333';
              }
            }
          }
        });
      };

      // Function to wait for all images to load
      const waitForImages = (container) => {
        return new Promise((resolve) => {
          const images = container.querySelectorAll('img');
          if (images.length === 0) {
            resolve();
            return;
          }
          
          let loadedCount = 0;
          const totalImages = images.length;
          
          const checkComplete = () => {
            loadedCount++;
            if (loadedCount === totalImages) {
              // Small delay to ensure rendering is complete
              setTimeout(resolve, 100);
            }
          };
          
          images.forEach((img) => {
            if (img.complete) {
              checkComplete();
            } else {
              img.onload = checkComplete;
              img.onerror = checkComplete; // Continue even if image fails to load
            }
          });
        });
      };

      // Function to add a section to PDF, scaling to fit on one page
      const addSectionToPDF = async (sectionElement, startNewPage = false) => {
        // Always start a new page for each section
        pdf.addPage();
        currentY = 10;

        const tempContainer = createSectionContainer(sectionElement);
        document.body.appendChild(tempContainer);

        // Wait for images to load before capturing
        await waitForImages(tempContainer);
        
        // Ensure all text is dark/black for readability
        ensureDarkText(tempContainer);
        
        // Force a reflow to ensure all content is rendered
        tempContainer.offsetHeight;

        const canvas = await html2canvas(tempContainer, {
          scale: 1.2, // Reduced from 2 to reduce file size while maintaining quality
          useCORS: true,
          allowTaint: true,
          backgroundColor: '#ffffff',
          width: 800,
          logging: false,
          // Don't limit height - let html2canvas capture the full content
        });

        document.body.removeChild(tempContainer);

        // Use JPEG compression instead of PNG to significantly reduce file size
        const imgData = canvas.toDataURL('image/jpeg', 0.85); // 85% quality JPEG
        
        // Calculate natural dimensions
        const naturalWidth = canvas.width;
        const naturalHeight = canvas.height;
        const naturalAspectRatio = naturalWidth / naturalHeight;
        
        // Calculate available space on page (with margins)
        const availableWidth = pageWidth;
        const availableHeight = pageHeight - currentY;
        
        // Calculate scale to fit within available space
        const widthScale = availableWidth / naturalWidth;
        const heightScale = availableHeight / naturalHeight;
        const scale = Math.min(widthScale, heightScale); // Use the smaller scale to fit both dimensions
        
        // Calculate final dimensions
        const finalWidth = naturalWidth * scale;
        const finalHeight = naturalHeight * scale;
        
        // Add image scaled to fit on the page
        pdf.addImage(imgData, 'JPEG', 10, currentY, finalWidth, finalHeight);
        currentY += finalHeight + 10;
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
                <h2 className="text-2xl font-bold text-gray-100 flex items-center gap-2">
                  {receiverNames[rcv_key] ? (
                    <>
                      <span>{receiverNames[rcv_key]}</span>
                      <span className="text-gray-500 text-lg font-normal">({rcv_key})</span>
                    </>
                  ) : (
                    <span>{rcv_key}</span>
                  )}
                </h2>
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

        {/* Racks Section Header */}
        {racks.length > 0 && (
          <div className="mt-8 page-break-inside-avoid page-break-before-always">
            <div className="border-b-2 border-gray-600 pb-2 mb-4">
              <h2 className="text-2xl font-bold text-gray-100">Rack Loadouts</h2>
              <p className="text-gray-400">Racks and their shell assignments with receiver and cue mappings</p>
            </div>
          </div>
        )}
          
        {racks.length === 0 ? (
          <div className="mt-8 page-break-inside-avoid page-break-before-always">
            <div className="text-gray-500 italic text-center py-4">
              No racks found for this show.
            </div>
          </div>
        ) : (
          racks.flatMap((rack) => {
                const cells = rack.cells || {};
                const fuses = rack.fuses || {};
                const rackCellMap = cellToItemMap[rack.id] || {};
                
                // Get shell data helper
                const getShellData = (shellId) => {
                  if (!inventory || !shellId) return null;
                  return inventory.find(item => item.id === shellId);
                };

                // Get shell description from metadata
                const getShellDescription = (shellData, shellNumber) => {
                  if (!shellData || !shellNumber) return null;
                  try {
                    const metadata = shellData.metadata 
                      ? (typeof shellData.metadata === 'string' 
                          ? JSON.parse(shellData.metadata) 
                          : shellData.metadata)
                      : null;
                    const packShellData = metadata?.pack_shell_data;
                    if (packShellData?.shells && packShellData.shells.length >= shellNumber) {
                      return packShellData.shells[shellNumber - 1]?.description || null;
                    }
                  } catch (e) {
                    console.error('Failed to parse shell metadata:', e);
                  }
                  return null;
                };

                // Get fuse data helper
                const getFuseData = (fuseId) => {
                  if (!inventory || !fuseId) return null;
                  return inventory.find(item => item.type === 'FUSE' && item.id === parseInt(fuseId));
                };

                // Calculate cell center position for fuse line drawing
                const getCellCenter = (x, y) => {
                  const cellWidth = 130; // cell width
                  const cellHeight = 140; // cell height
                  const gap = 4; // gap-1 = 4px
                  const xPos = x * (cellWidth + gap) + cellWidth / 2;
                  const yPos = y * (cellHeight + gap) + cellHeight / 2;
                  return { x: xPos, y: yPos };
                };

                // Render fuse lines
                const renderFuseLines = () => {
                  const lines = [];
                  
                  for (const [fuseId, fuse] of Object.entries(fuses)) {
                    if (!fuse.cells || fuse.cells.length < 2) continue;
                    
                    // Get fuse color from inventory
                    const fuseItem = getFuseData(fuse.type);
                    const fuseColor = fuseItem?.color || '#FFD700';
                    
                    // Draw line connecting consecutive cells
                    for (let i = 0; i < fuse.cells.length - 1; i++) {
                      const [x1, y1] = fuse.cells[i].split('_').map(Number);
                      const [x2, y2] = fuse.cells[i + 1].split('_').map(Number);
                      const start = getCellCenter(x1, y1);
                      const end = getCellCenter(x2, y2);
                      
                      lines.push(
                        <line
                          key={`${fuseId}_${i}`}
                          x1={start.x}
                          y1={start.y}
                          x2={end.x}
                          y2={end.y}
                          stroke={fuseColor}
                          strokeWidth="4"
                          strokeLinecap="round"
                        />
                      );
                    }
                  }
                  
                  return lines;
                };

                // Calculate grid dimensions for SVG
                const cellWidth = 130;
                const cellHeight = 140;
                const gap = 4;
                const gridWidth = rack.x_rows * (cellWidth + gap) - gap;
                const gridHeight = rack.y_rows * (cellHeight + gap) - gap;

                return [
                  // Rack Grid Section - Each rack gets its own page
                  <div key={`rack-${rack.id}`} className="mb-8 page-break-inside-avoid page-break-before-always">
                    {/* Rack Header */}
                    <div className="border-b border-gray-600 pb-2 mb-4">
                      <h3 className="text-xl font-bold text-gray-100">{rack.name}</h3>
                      <p className="text-gray-400 text-sm">
                        Grid: {rack.x_rows} × {rack.y_rows} | 
                        Spacing: {rack.x_spacing}" × {rack.y_spacing}"
                      </p>
                    </div>

                    {/* Rack Grid */}
                    <div className="mb-4 relative inline-block">
                    <div 
                      className="grid gap-1 relative"
                      style={{ 
                        gridTemplateColumns: `repeat(${rack.x_rows}, 130px)`,
                        width: `${gridWidth}px`,
                      }}
                    >
                      {/* SVG overlay for fuse lines - above cells */}
                      <svg
                        className="absolute inset-0 pointer-events-none"
                        style={{ 
                          width: `${gridWidth}px`, 
                          height: `${gridHeight}px`,
                          zIndex: 2
                        }}
                      >
                        {renderFuseLines()}
                      </svg>
                      {Array.from({ length: rack.y_rows }).map((_, y) =>
                        Array.from({ length: rack.x_rows }).map((_, x) => {
                          const cellKey = `${x}_${y}`;
                          const cellData = cells[cellKey];
                          const cellMapping = rackCellMap[cellKey];
                          // Debug: log if cellMapping exists
                          if (cellMapping) {
                            console.log(`Cell ${cellKey} has mapping:`, cellMapping);
                          }
                          const shellData = cellData?.shellId ? getShellData(cellData.shellId) : null;
                          const shellDescription = shellData && cellData?.shellNumber 
                            ? getShellDescription(shellData, cellData.shellNumber) 
                            : null;
                          const fuseData = cellData?.fuseId ? fuses[cellData.fuseId] : null;
                          const fuseItem = fuseData ? getFuseData(fuseData.type) : null;

                          return (
                            <div
                              key={cellKey}
                              className={`
                                border-2 rounded p-2 relative
                                ${cellMapping 
                                  ? 'border-blue-500 bg-blue-900/20' 
                                  : cellData?.shellId 
                                    ? 'border-gray-500 bg-gray-800' 
                                    : 'border-gray-700 bg-gray-900'
                                }
                              `}
                              style={{
                                width: '130px',
                                height: '140px',
                                zIndex: 1
                              }}
                            >
                              {/* Receiver and Cue Assignment - Top Right - above fuse lines */}
                              {cellMapping && (
                                <div className="absolute top-1 right-1 text-[10px] text-blue-200 text-right leading-tight" style={{ zIndex: 4 }}>
                                  <div className="font-semibold whitespace-nowrap">
                                    {cellMapping.receiverName}
                                  </div>
                                  <div className="text-blue-300 whitespace-nowrap">
                                    {cellMapping.zone}:{cellMapping.target}
                                  </div>
                                </div>
                              )}

                              {/* Cell Position */}
                              <div className="text-xs text-gray-400 mb-1 text-center">
                                ({x}, {y})
                              </div>

                              {/* Shell Info */}
                              {shellData ? (
                                <>
                                  {shellData.image && (
                                    <div className="mb-1 flex justify-center">
                                      <img
                                        src={shellData.image}
                                        alt={shellData.name}
                                        className="w-8 h-8 object-cover rounded border border-gray-600"
                                      />
                                    </div>
                                  )}
                                  <div className="text-xs text-gray-200 text-center font-semibold mb-1">
                                    {shellData.name}
                                  </div>
                                  {cellData.shellNumber && (
                                    <div className="text-xs text-gray-400 text-center mb-1">
                                      #{cellData.shellNumber}
                                    </div>
                                  )}
                                  {shellDescription && (
                                    <div className="text-xs text-gray-300 text-center mt-1 italic px-1">
                                      {shellDescription}
                                    </div>
                                  )}
                                </>
                              ) : (
                                <div className="text-xs text-gray-600 text-center italic">
                                  Empty
                                </div>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                  </div>,
                  
                  // Fuses Summary Section - Each fuses section gets its own page
                  Object.keys(fuses).length > 0 && (
                    <div key={`fuses-${rack.id}`} className="mb-8 page-break-inside-avoid page-break-before-always">
                      <div className="border-b border-gray-600 pb-2 mb-4">
                        <h3 className="text-xl font-bold text-gray-100">Fuses in {rack.name}</h3>
                      </div>
                      <div className="mt-4 p-4 bg-gray-800 rounded-lg">
                        <h4 className="text-lg font-semibold text-gray-100 mb-3">Fuse Details</h4>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                        {Object.entries(fuses).map(([fuseId, fuse]) => {
                          const fuseItem = getFuseData(fuse.type);
                          if (!fuseItem) return null;
                          
                          // Calculate total fuse length
                          let totalFuseLength = fuse.leadIn || 0;
                          if (fuse.cells && fuse.cells.length > 1) {
                            // Calculate distance between consecutive cells
                            for (let i = 0; i < fuse.cells.length - 1; i++) {
                              const [x1, y1] = fuse.cells[i].split('_').map(Number);
                              const [x2, y2] = fuse.cells[i + 1].split('_').map(Number);
                              
                              // Calculate distance using rack spacing
                              const xDiff = Math.abs(x2 - x1);
                              const yDiff = Math.abs(y2 - y1);
                              const distance = (xDiff * rack.x_spacing) + (yDiff * rack.y_spacing);
                              totalFuseLength += distance;
                            }
                          }
                          
                          // Add 1 inch safety margin
                          const totalFuseLengthWithMargin = totalFuseLength + 1;
                          
                          return (
                            <div
                              key={fuseId}
                              className="border border-yellow-600 rounded p-3 bg-gray-700"
                            >
                              <div className="flex items-center gap-2 mb-2">
                                <div 
                                  className="w-4 h-4 rounded-full border border-gray-500"
                                  style={{ backgroundColor: fuseItem.color || '#FFD700' }}
                                />
                                <div className="text-sm font-semibold text-gray-100">
                                  {fuseItem.name}
                                </div>
                              </div>
                              <div className="text-xs text-gray-400 mb-1">
                                Burn Rate: {fuseItem.burn_rate} s/ft
                              </div>
                              <div className="text-xs text-yellow-300 mb-1 font-semibold">
                                Total Length: {totalFuseLengthWithMargin.toFixed(2)}" (includes 1" safety margin)
                              </div>
                              {fuse.leadIn > 0 && (
                                <div className="text-xs text-gray-400 mb-1">
                                  Lead-In: {fuse.leadIn}"
                                </div>
                              )}
                              {fuse.cells && fuse.cells.length > 0 && (
                                <div className="text-xs text-yellow-400 mt-2">
                                  Connected Cells ({fuse.cells.length}): {fuse.cells.join(', ')}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      </div>
                    </div>
                  )
                ].filter(Boolean); // Remove any false/null values
              })
        )}

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