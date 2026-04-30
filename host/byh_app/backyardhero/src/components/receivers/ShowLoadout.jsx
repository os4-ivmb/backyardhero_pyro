import useAppStore from "@/store/useAppStore"
import useStateAppStore from "@/store/useStateAppStore";
import {
  buildShellUsageCountsFromRackCellAssignments,
  parseShellPackShellKey,
} from "@/utils/shellUsageCounts";
import { useEffect, useMemo, useRef, useState } from "react";
import { MdDownload, MdPrint, MdArrowBack, MdSave } from 'react-icons/md';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import SpatialLayoutMap from '../builder/SpatialLayoutMap';
import axios from 'axios';

function getShellDescriptionFromMetadata(shellData, shellNumber) {
  if (!shellData || shellNumber == null || shellNumber === 0) return null;
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
}

/** Timeline item types listed under Items to Pack (shells/racks covered elsewhere). */
const CAKE_AND_FOUNTAIN_PACK_TYPES = new Set([
  'CAKE_FOUNTAIN',
  'CAKE_200G',
  'CAKE_350G',
  'CAKE_500G',
  'COMPOUND_CAKE',
]);

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

  // Cakes and fountain cakes only (shells / rack cues are in other sections)
  const getItemsToPack = () => {
    if (!stagedShow?.items) return [];

    const itemCounts = {};

    stagedShow.items.forEach((item) => {
      if (!CAKE_AND_FOUNTAIN_PACK_TYPES.has(item.type)) return;
      const key = `${item.name}-${item.type}`;
      if (!itemCounts[key]) {
        itemCounts[key] = {
          ...item,
          count: 0,
        };
      }
      itemCounts[key].count += 1;
    });

    return Object.values(itemCounts).sort((a, b) => a.name.localeCompare(b.name));
  };

  const shellsToPackByPack = useMemo(() => {
    const usage = buildShellUsageCountsFromRackCellAssignments(stagedShow?.items, racks);
    if (!usage.size) return [];

    const packShells = new Map();

    for (const [usageKey, count] of usage.entries()) {
      const parsed = parseShellPackShellKey(usageKey);
      if (!parsed) continue;
      const { shellId, shellNumber } = parsed;
      const idKey = String(shellId);
      if (!packShells.has(idKey)) {
        packShells.set(idKey, new Map());
      }
      const numKey = shellNumber === null ? 'any' : shellNumber;
      const inner = packShells.get(idKey);
      inner.set(numKey, (inner.get(numKey) || 0) + count);
    }

    return [...packShells.entries()]
      .map(([idKey, shellNumMap]) => {
        const shellData =
          inventory.find((inv) => String(inv.id) === idKey || inv.id === Number(idKey)) || null;
        const packName = shellData?.name || `Shell pack (${idKey})`;
        const shells = [...shellNumMap.entries()]
          .map(([snKey, c]) => {
            const shellNumber = snKey === 'any' ? null : snKey;
            return {
              shellNumber,
              count: c,
              description: getShellDescriptionFromMetadata(shellData, shellNumber),
            };
          })
          .sort((a, b) => {
            if (a.shellNumber == null && b.shellNumber == null) return 0;
            if (a.shellNumber == null) return 1;
            if (b.shellNumber == null) return -1;
            return a.shellNumber - b.shellNumber;
          });
        return { idKey, packName, shells };
      })
      .filter((p) => p.shells.length > 0)
      .sort((a, b) => a.packName.localeCompare(b.packName));
  }, [stagedShow?.items, racks, inventory]);

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
      const margin = 10;
      const PDF_CAPTURE_SCALE = 1;
      const PDF_JPEG_QUALITY = 0.82;
      const PDF_IMG_MAX_CSS_PX = 200;

      const downscaleImagesForPdf = (root) => {
        if (!root.querySelectorAll) return;
        root.querySelectorAll('img').forEach((img) => {
          img.style.maxWidth = `${PDF_IMG_MAX_CSS_PX}px`;
          img.style.maxHeight = `${PDF_IMG_MAX_CSS_PX}px`;
          img.style.objectFit = 'contain';
        });
      };

      /** Dense, readable layout for Shells section in PDF rasterization only */
      const compactShellsSectionForPdf = (sectionRoot) => {
        if (sectionRoot.getAttribute('data-loadout-section') !== 'shells') return;

        sectionRoot.style.marginTop = '0';
        sectionRoot.style.backgroundColor = '#ffffff';

        const headerBlock = sectionRoot.querySelector('[data-shell-pdf-header]');
        if (headerBlock) {
          headerBlock.style.paddingBottom = '4px';
          headerBlock.style.marginBottom = '6px';
          headerBlock.style.borderBottom = '2px solid #333';
          headerBlock.querySelectorAll('h2').forEach((h) => {
            h.style.fontSize = '16px';
            h.style.margin = '0';
            h.style.color = '#111827';
            h.style.fontWeight = '700';
          });
          headerBlock.querySelectorAll('p').forEach((p) => {
            p.style.fontSize = '10px';
            p.style.margin = '2px 0 0 0';
            p.style.color = '#374151';
            p.style.lineHeight = '1.2';
          });
        }

        const grid = sectionRoot.querySelector('[data-shells-grid]');
        if (grid) {
          grid.style.display = 'grid';
          grid.style.gridTemplateColumns = 'repeat(3, minmax(0, 1fr))';
          grid.style.gap = '6px';
          grid.style.alignItems = 'start';
        } else {
          sectionRoot.style.display = 'flex';
          sectionRoot.style.flexDirection = 'column';
          sectionRoot.style.gap = '6px';
          sectionRoot.style.alignItems = 'stretch';
        }

        sectionRoot.querySelectorAll('[data-shell-pack]').forEach((card) => {
          card.style.padding = '5px 7px';
          card.style.margin = '0';
          card.style.width = '100%';
          card.style.maxWidth = '100%';
          card.style.backgroundColor = '#f3f4f6';
          card.style.border = '1px solid #9ca3af';
          card.style.borderRadius = '3px';
          card.style.minHeight = 'unset';
          card.style.boxSizing = 'border-box';

          const title = card.querySelector('h3');
          if (title) {
            title.style.fontSize = '11px';
            title.style.fontWeight = '700';
            title.style.margin = '0 0 3px 0';
            title.style.padding = '0';
            title.style.color = '#111827';
            title.style.lineHeight = '1.2';
            title.querySelectorAll('span').forEach((s) => {
              s.style.color = '#4b5563';
              s.style.fontWeight = '600';
            });
          }

          const ul = card.querySelector('ul');
          if (ul) {
            ul.style.margin = '0';
            ul.style.padding = '0';
            ul.style.listStyle = 'none';
          }

          card.querySelectorAll('li').forEach((li) => {
            li.style.display = 'flex';
            li.style.flexDirection = 'row';
            li.style.flexWrap = 'wrap';
            li.style.alignItems = 'baseline';
            li.style.columnGap = '6px';
            li.style.rowGap = '0';
            li.style.padding = '1px 0 2px 0';
            li.style.margin = '0';
            li.style.borderBottom = '1px solid #d1d5db';
            li.style.fontSize = '10px';
            li.style.lineHeight = '1.25';
            li.style.color = '#1f2937';

            const spans = li.querySelectorAll(':scope > span');
            spans.forEach((sp, idx) => {
              sp.style.margin = '0';
              sp.style.padding = '0';
              if (idx === 0) {
                sp.style.fontFamily = 'ui-monospace, monospace';
                sp.style.fontWeight = '700';
                sp.style.color = '#1d4ed8';
                sp.style.flexShrink = '0';
              } else if (idx === 1) {
                sp.style.fontWeight = '700';
                sp.style.color = '#047857';
                sp.style.flexShrink = '0';
              } else {
                sp.style.fontWeight = '400';
                sp.style.color = '#111827';
                sp.style.flex = '1 1 120px';
                sp.style.minWidth = '0';
              }
            });
          });

          const lastLi = card.querySelector('li:last-of-type');
          if (lastLi) lastLi.style.borderBottom = 'none';
        });
      };

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
        downscaleImagesForPdf(sectionClone);
        
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
        compactShellsSectionForPdf(sectionClone);
        tempContainer.appendChild(sectionClone);
        return tempContainer;
      };

      // Rasterize as JPEG (much smaller than PNG) and slice tall captures across pages.
      const addSectionToPDF = async (sectionElement, startNewPage = false) => {
        if (startNewPage) {
          pdf.addPage();
          currentY = margin;
        }

        const tempContainer = createSectionContainer(sectionElement);
        document.body.appendChild(tempContainer);

        const canvas = await html2canvas(tempContainer, {
          scale: PDF_CAPTURE_SCALE,
          useCORS: true,
          allowTaint: true,
          backgroundColor: '#ffffff',
          width: 800,
          height: tempContainer.scrollHeight,
          logging: false,
        });

        document.body.removeChild(tempContainer);

        const imgWmm = pageWidth;
        const fullHmm = (canvas.height * imgWmm) / canvas.width;
        const bottomLimit = pageHeight - margin;

        const placeOneShot = () => {
          if (currentY + fullHmm > bottomLimit) {
            pdf.addPage();
            currentY = margin;
          }
          const imgData = canvas.toDataURL('image/jpeg', PDF_JPEG_QUALITY);
          pdf.addImage(imgData, 'JPEG', margin, currentY, imgWmm, fullHmm);
          currentY += fullHmm + 5;
        };

        const placeSliced = () => {
          let srcY = 0;
          while (srcY < canvas.height) {
            if (currentY >= bottomLimit - 5) {
              pdf.addPage();
              currentY = margin;
            }
            const availableMm = bottomLimit - currentY;
            let slicePx = Math.floor((availableMm * canvas.width) / imgWmm);
            slicePx = Math.min(Math.max(1, slicePx), canvas.height - srcY);
            const sliceCanvas = document.createElement('canvas');
            sliceCanvas.width = canvas.width;
            sliceCanvas.height = slicePx;
            sliceCanvas.getContext('2d').drawImage(
              canvas,
              0,
              srcY,
              canvas.width,
              slicePx,
              0,
              0,
              canvas.width,
              slicePx
            );
            const sliceHmm = (slicePx * imgWmm) / canvas.width;
            const imgData = sliceCanvas.toDataURL('image/jpeg', PDF_JPEG_QUALITY);
            pdf.addImage(imgData, 'JPEG', margin, currentY, imgWmm, sliceHmm);
            currentY += sliceHmm;
            srcY += slicePx;
          }
          currentY += 5;
        };

        if (fullHmm <= bottomLimit - margin) {
          placeOneShot();
        } else {
          placeSliced();
        }
      };

      // Get all sections
      const loadoutContent = loadoutRef.current;
      const sections = loadoutContent.children;

      // Process each section (split rack block into one capture per rack — avoids huge bitmaps)
      for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        const shouldStartNewPage = section.classList.contains('page-break-before-always');

        // Skip the spatial layout section for PDF export
        const isSpatialLayout = section.textContent.includes('Spatial Layout');
        if (isSpatialLayout) {
          continue;
        }

        const isRacksSection = section.getAttribute('data-loadout-section') === 'racks';
        if (isRacksSection) {
          const headerEl = section.querySelector('[data-rack-pdf-header]');
          const rackChunks = section.querySelectorAll('[data-rack-pdf-chunk]');
          if (rackChunks.length === 0) {
            await addSectionToPDF(section, shouldStartNewPage);
            continue;
          }
          for (let r = 0; r < rackChunks.length; r++) {
            const wrapper = document.createElement('div');
            if (r === 0 && headerEl) {
              wrapper.appendChild(headerEl.cloneNode(true));
            }
            wrapper.appendChild(rackChunks[r].cloneNode(true));
            const startPage = r === 0 ? shouldStartNewPage : true;
            await addSectionToPDF(wrapper, startPage);
          }
          continue;
        }

        const isShellsSection = section.getAttribute('data-loadout-section') === 'shells';
        if (isShellsSection) {
          const shellHeaderEl = section.querySelector('[data-shell-pdf-header]');
          const shellPacks = section.querySelectorAll('[data-shell-pack]');
          if (shellPacks.length === 0) {
            await addSectionToPDF(section, shouldStartNewPage);
            continue;
          }
          for (let s = 0; s < shellPacks.length; s++) {
            const wrapper = document.createElement('div');
            wrapper.setAttribute('data-loadout-section', 'shells');
            if (s === 0 && shellHeaderEl) {
              wrapper.appendChild(shellHeaderEl.cloneNode(true));
            }
            wrapper.appendChild(shellPacks[s].cloneNode(true));
            const startPage = s === 0 ? shouldStartNewPage : true;
            await addSectionToPDF(wrapper, startPage);
          }
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

        {/* Racks Section */}
        <div
          className="mt-8 page-break-inside-avoid page-break-before-always"
          data-loadout-section="racks"
        >
          <div className="border-b-2 border-gray-600 pb-2 mb-4" data-rack-pdf-header>
            <h2 className="text-2xl font-bold text-gray-100">Rack Loadouts</h2>
            <p className="text-gray-400">Racks and their shell assignments with receiver and cue mappings</p>
          </div>
          
          {racks.length === 0 ? (
            <div className="text-gray-500 italic text-center py-4">
              No racks found for this show.
            </div>
          ) : (
            racks.map((rack) => {
                const cells = rack.cells || {};
                const fuses = rack.fuses || {};
                const rackCellMap = cellToItemMap[rack.id] || {};
                
                // Get shell data helper
                const getShellData = (shellId) => {
                  if (!inventory || !shellId) return null;
                  return inventory.find(item => item.id === shellId);
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

                return (
                  <div key={rack.id} className="mb-8 page-break-inside-avoid" data-rack-pdf-chunk>
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
                              ? getShellDescriptionFromMetadata(shellData, cellData.shellNumber)
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

                    {/* Fuses Summary */}
                    {Object.keys(fuses).length > 0 && (
                      <div className="mt-4 p-4 bg-gray-800 rounded-lg">
                        <h4 className="text-lg font-semibold text-gray-100 mb-3">Fuses in {rack.name}</h4>
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
                    )}
                  </div>
                );
              })
          )}
        </div>

        {/* Shells to pack — by shell pack, then shell # / description */}
        <div
          className="mt-8 page-break-inside-avoid page-break-before-always"
          data-loadout-section="shells"
        >
          <div className="border-b-2 border-gray-600 pb-2 mb-4" data-shell-pdf-header>
            <h2 className="text-2xl font-bold text-gray-100">Shells</h2>
            <p className="text-gray-400">
              Shell packs and positions needed for assigned rack cells in this show
            </p>
          </div>
          {shellsToPackByPack.length === 0 ? (
            <div className="text-gray-500 italic text-center py-4">
              No rack shell usage in this show (assign RACK_SHELLS cues to rack cells with shells).
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" data-shells-grid>
              {shellsToPackByPack.map((pack) => {
                const packTotal = pack.shells.reduce((sum, row) => sum + row.count, 0);
                return (
                <div
                  key={pack.idKey}
                  className="border border-gray-600 rounded-lg p-4 bg-gray-800/80 min-w-0"
                  data-shell-pack
                >
                  <h3 className="text-lg font-semibold text-gray-100 mb-3">
                    {pack.packName}
                    <span className="text-gray-400 font-normal"> ({packTotal})</span>
                  </h3>
                  <ul className="space-y-2">
                    {pack.shells.map((row) => (
                      <li
                        key={row.shellNumber === null ? 'any' : row.shellNumber}
                        className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-gray-300 border-b border-gray-700/80 pb-2 last:border-0 last:pb-0"
                      >
                        <span className="font-mono text-blue-300 shrink-0">
                          ×{row.count}
                        </span>
                        <span className="font-semibold text-gray-200 shrink-0">
                          {row.shellNumber != null ? `#${row.shellNumber}` : '# (any)'}
                        </span>
                        {row.description ? (
                          <span className="text-gray-400 break-words min-w-0">{row.description}</span>
                        ) : (
                          <span className="text-gray-500 italic">No description</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Items to pack (photo when available) */}
        {(() => {
          const itemsToPack = getItemsToPack();
          if (itemsToPack.length === 0) return null;

          return (
            <div className="mt-8 page-break-inside-avoid page-break-before-always">
              <div className="border-b-2 border-gray-600 pb-2 mb-4">
                <h2 className="text-2xl font-bold text-gray-100">Items to Pack</h2>
                <p className="text-gray-400">
                  Cakes and fountain cakes only — counts (photo when available)
                </p>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {itemsToPack.map((item, index) => (
                  <div
                    key={index}
                    className="border-2 border-gray-600 rounded-lg p-4 bg-gray-800 flex flex-col items-center"
                  >
                    {item.image ? (
                      <div className="mb-3">
                        <img
                          src={item.image}
                          alt={item.name}
                          className="w-20 h-20 object-cover rounded-lg border border-gray-600"
                        />
                      </div>
                    ) : null}

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