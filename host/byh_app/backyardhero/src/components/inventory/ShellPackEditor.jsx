import React, { useState, useEffect } from 'react';
import useAppStore from '@/store/useAppStore';
import axios from 'axios';

const EFFECT_OPTIONS = [
  'PEONY',
  'CHRYSANTHEMUM',
  'BROCADE',
  'BROCADE_CROWN',
  'WILLOW',
  'KAMURO',
  'PALM',
  'HORSETAIL',
  'CURTAIN',
  'WATERFALL',
  'RING',
  'DOUBLE_RING',
  'TRIPLE_RING',
  'PATTERN',
  'GEOMETRIC',
  'SHAPE',
  'HEART',
  'LETTER',
  'LOGO',
  'DOUBLE_BREAK',
  'TRIPLE_BREAK',
  'MULTI_BREAK',
  'TIME_BREAK',
  'DELAYED_BREAK',
  'CRACKLE',
  'DRAGON_EGG',
  'MICRO_CRACKLE',
  'BROKEN',
  'DIRTY',
  'IRREGULAR',
  'COMET',
  'RISING_TAIL',
  'FALLING_TAIL',
  'SPINNER',
  'TOURBILLON',
  'SWIRL',
  'STROBE',
  'GLITTER',
  'TIME_RAIN',
  'COLOR_CHANGE',
  'FLASH',
  'NISHIKI',
  'NISHIKI_WILLOW',
  'NISHIKI_KAMURO',
  'NISHIKI_BROCADE',
  'COCONUT',
  'MEATBALL',
  'CHUNKY',
  'SALUTE',
  'REPORT',
  'CROWN',
  'HALO',
  'GHOST',
  'SMOKE',
  'TAIL',
  'DAHLIA',
  'WAVE',
  'WHISTLING'
];

// Comprehensive color name to hex mapping (exhaustive)
const COLOR_MAP = {
  // Yellow/Lemon/Gold
  'lemon': '#FFFF00',
  'yellow': '#FFFF00',
  'gold': '#FFD700',
  'golden': '#FFD700',
  'nishiki': '#FFD700', // Nishiki is a gold color
  // Orange
  'orange': '#FFA500',
  // Red
  'red': '#FF0000',
  'deep red': '#8B0000',
  'deepred': '#8B0000',
  'crimson': '#DC143C',
  'scarlet': '#FF2400',
  'burgundy': '#800020',
  // Blue
  'blue': '#0000FF',
  'navy': '#000080',
  'royal blue': '#4169E1',
  'royalblue': '#4169E1',
  'sky blue': '#87CEEB',
  'skyblue': '#87CEEB',
  'cyan': '#00FFFF',
  'aqua': '#00FFFF',
  // Green
  'green': '#008000',
  'lime': '#00FF00',
  'emerald': '#50C878',
  'forest green': '#228B22',
  'forestgreen': '#228B22',
  // Purple/Violet
  'purple': '#800080',
  'violet': '#8A2BE2',
  'lavender': '#E6E6FA',
  'magenta': '#FF00FF',
  'fuchsia': '#FF00FF',
  // White/Silver/Titanium
  'white': '#FFFFFF',
  'silver': '#C0C0C0',
  'titanium': '#FFFFFF',
  'platinum': '#E5E4E2',
  // Pink
  'pink': '#FFC0CB',
  'rose': '#FF007F',
  // Brown
  'brown': '#A52A2A',
  'tan': '#D2B48C',
  // Black
  'black': '#000000',
  // Multi/Other
  'rainbow': '#FFFFFF', // Default to white for rainbow
};

// Effect root words - we'll match these as roots in words
const EFFECT_ROOTS = {
  // Peony family
  'peony': 'PEONY',
  'pearl': 'PEONY',
  'plum': 'PEONY',
  // Chrysanthemum
  'chrysanthemum': 'CHRYSANTHEMUM',
  'mum': 'CHRYSANTHEMUM',
  // Brocade
  'brocade': 'BROCADE',
  // Crown
  'crown': 'CROWN',
  // Willow
  'willow': 'WILLOW',
  // Wave
  'wave': 'WAVE',
  // Palm
  'palm': 'PALM',
  // Coconut
  'coconut': 'COCONUT',
  // Strobe
  'strobe': 'STROBE',
  // Crackle
  'crackle': 'CRACKLE',
  'crackling': 'CRACKLE',
  // Glitter - root matching will find "glitter" in "glittering", "glitters", etc.
  'glitter': 'GLITTER',
  // Dahlia
  'dahlia': 'DAHLIA',
  // Ring
  'ring': 'RING',
  'double ring': 'DOUBLE_RING',
  'triple ring': 'TRIPLE_RING',
  // Dragon
  'dragon': 'DRAGON_EGG',
  'dragon egg': 'DRAGON_EGG',
  // Comet
  'comet': 'COMET',
  // Ghost
  'ghost': 'GHOST',
  // Smoke
  'smoke': 'SMOKE',
  // Tail
  'tail': 'TAIL',
  'rising tail': 'RISING_TAIL',
  'falling tail': 'FALLING_TAIL',
  // Spinner
  'spinner': 'SPINNER',
  // Tourbillon
  'tourbillon': 'TOURBILLON',
  // Swirl
  'swirl': 'SWIRL',
  // Flash
  'flash': 'FLASH',
  // Salute
  'salute': 'SALUTE',
  // Report
  'report': 'REPORT',
  // Halo
  'halo': 'HALO',
  // Nishiki
  'nishiki': 'NISHIKI',
  'nishiki willow': 'NISHIKI_WILLOW',
  'nishiki kamuro': 'NISHIKI_KAMURO',
  'nishiki brocade': 'NISHIKI_BROCADE',
  // Meatball
  'meatball': 'MEATBALL',
  // Break
  'break': 'MULTI_BREAK',
  'double break': 'DOUBLE_BREAK',
  'triple break': 'TRIPLE_BREAK',
  'multi break': 'MULTI_BREAK',
  'time break': 'TIME_BREAK',
  'delayed break': 'DELAYED_BREAK',
  // Horsetail
  'horsetail': 'HORSETAIL',
  // Curtain
  'curtain': 'CURTAIN',
  // Waterfall
  'waterfall': 'WATERFALL',
  // Kamuro
  'kamuro': 'KAMURO',
  // Micro crackle
  'micro crackle': 'MICRO_CRACKLE',
  // Time rain
  'time rain': 'TIME_RAIN',
  // Color change
  'color change': 'COLOR_CHANGE',
  // Brocade crown
  'brocade crown': 'BROCADE_CROWN',
  'super brocade crown': 'BROCADE_CROWN',
  // Chunky
  'chunky': 'CHUNKY',
  // Pattern
  'pattern': 'PATTERN',
  // Geometric
  'geometric': 'GEOMETRIC',
  // Shape
  'shape': 'SHAPE',
  // Heart
  'heart': 'HEART',
  // Letter
  'letter': 'LETTER',
  // Logo
  'logo': 'LOGO',
  // Whistling
  'whistl': 'WHISTLING',
};

export default function ShellPackEditor({ isOpen, onClose, item }) {
  const { updateInventoryItem, fetchInventory } = useAppStore();
  const [shellCount, setShellCount] = useState(1);
  const [shells, setShells] = useState([]);
  const [quickAddText, setQuickAddText] = useState('');
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [useAIParser, setUseAIParser] = useState(false);
  const [apiKey, setApiKey] = useState(() => {
    // Load from localStorage if available
    if (typeof window !== 'undefined') {
      return localStorage.getItem('openai_api_key') || '';
    }
    return '';
  });
  const [selectedEffectToAdd, setSelectedEffectToAdd] = useState({}); // Map shellIndex -> selected effect

  // Initialize shells from item metadata
  useEffect(() => {
    if (item && item.metadata) {
      try {
        const metadata = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;
        const packShellData = metadata?.pack_shell_data;
        
        if (packShellData && packShellData.shells && packShellData.shells.length > 0) {
          // Ensure shells have proper structure
          const loadedShells = packShellData.shells.map((shell, index) => ({
            number: index + 1,
            description: shell.description || '',
            colors: shell.colors || [],
            effects: shell.effects || []
          }));
          setShells(loadedShells);
          setShellCount(loadedShells.length);
        } else {
          // Initialize with one empty shell
          setShells([{ number: 1, description: '', colors: [], effects: [] }]);
          setShellCount(1);
        }
      } catch (e) {
        console.error('Failed to parse metadata:', e);
        setShells([{ number: 1, description: '', colors: [], effects: [] }]);
        setShellCount(1);
      }
    } else {
      // Initialize with one empty shell
      setShells([{ number: 1, description: '', colors: [], effects: [] }]);
      setShellCount(1);
    }
  }, [item]);

  // Update shell count and adjust shells array
  const handleShellCountChange = (newCount) => {
    const count = Math.max(1, Math.min(24, parseInt(newCount) || 1));
    setShellCount(count);
    
    // Adjust shells array
    if (count > shells.length) {
      // Add new shells
      const newShells = [...shells];
      for (let i = shells.length; i < count; i++) {
        newShells.push({ number: i + 1, description: '', colors: [], effects: [] });
      }
      setShells(newShells);
    } else if (count < shells.length) {
      // Remove shells
      setShells(shells.slice(0, count));
    }
  };

  // Add color to a shell
  const addColor = (shellIndex) => {
    const newShells = [...shells];
    newShells[shellIndex].colors.push('#FFFFFF');
    setShells(newShells);
  };

  // Remove color from a shell
  const removeColor = (shellIndex, colorIndex) => {
    const newShells = [...shells];
    newShells[shellIndex].colors.splice(colorIndex, 1);
    setShells(newShells);
  };

  // Update color value
  const updateColor = (shellIndex, colorIndex, value) => {
    const newShells = [...shells];
    newShells[shellIndex].colors[colorIndex] = value;
    setShells(newShells);
  };

  // Add effect to a shell
  const addEffectToShell = (shellIndex) => {
    const effect = selectedEffectToAdd[shellIndex];
    if (!effect) return;
    
    const newShells = [...shells];
    if (!newShells[shellIndex].effects.includes(effect)) {
      newShells[shellIndex].effects.push(effect);
    }
    setShells(newShells);
    setSelectedEffectToAdd({ ...selectedEffectToAdd, [shellIndex]: '' });
  };

  // Remove effect from a shell
  const removeEffectFromShell = (shellIndex, effectIndex) => {
    const newShells = [...shells];
    newShells[shellIndex].effects.splice(effectIndex, 1);
    setShells(newShells);
  };

  // Parse all colors from text (can be multiple) - exhaustive matching
  const parseColors = (text) => {
    const lowerText = text.toLowerCase();
    const colors = [];
    const foundKeys = new Set();
    
    // Sort by key length (longest first) to match "deep red" before "red"
    const sortedEntries = Object.entries(COLOR_MAP).sort((a, b) => b[0].length - a[0].length);
    
    for (const [key, hex] of sortedEntries) {
      // Check if this key appears in the text (as whole word or part of word)
      // Use word boundaries for better matching
      const keyLower = key.toLowerCase();
      // Check if key is in text, but avoid matching if already found a longer key that contains it
      if (lowerText.includes(keyLower)) {
        // Check if we haven't already found a longer/more specific color
        let isMoreSpecific = true;
        for (const foundKey of foundKeys) {
          if (foundKey.includes(keyLower) && foundKey !== keyLower) {
            isMoreSpecific = false;
            break;
          }
        }
        if (isMoreSpecific && !colors.includes(hex)) {
          colors.push(hex);
          foundKeys.add(keyLower);
        }
      }
    }
    return colors;
  };

  // Parse effects from text using root matching
  const parseEffects = (text) => {
    const lowerText = text.toLowerCase();
    const effects = [];
    const foundRoots = new Set();
    
    // Sort by root length (longest first) to match longer/more specific roots first
    // This ensures "double ring" matches before "ring", "nishiki willow" before "nishiki", etc.
    const sortedEntries = Object.entries(EFFECT_ROOTS).sort((a, b) => b[0].length - a[0].length);
    
    for (const [root, effect] of sortedEntries) {
      // Check if root appears in the text
      // For single-word roots: match with word boundaries (space before/after or start/end)
      // This prevents "ring" from matching in "glittering"
      // For multi-word roots: simple contains check (less likely to have false matches)
      let isMatch = false;
      
      if (root.includes(' ')) {
        // Multi-word root: simple contains check
        isMatch = lowerText.includes(root);
      } else {
        // Single-word root: check for space before word OR if word starts with root
        // Match: " ring" (space before) OR word starts with root (like "glitter" in "glittering")
        // This prevents "ring" from matching in "glittering" but allows "glitter" in "glittering"
        const hasSpaceBefore = lowerText.includes(` ${root}`);
        const startsWith = lowerText.startsWith(root);
        // Check if any word in the text starts with this root
        const words = lowerText.split(/\s+/);
        const wordStartsWithRoot = words.some(word => word.startsWith(root));
        
        isMatch = hasSpaceBefore || startsWith || wordStartsWithRoot;
      }
      
      if (isMatch) {
        // Check if this root is more specific than any already found root
        // e.g., if we found "double ring", we should remove "ring"
        let shouldAdd = true;
        const rootsToRemove = [];
        
        for (const foundRoot of foundRoots) {
          // If the found root contains this root (and they map to different effects), 
          // this new root is more specific, so remove the less specific one
          if (foundRoot.includes(root) && foundRoot !== root) {
            const foundEffect = EFFECT_ROOTS[foundRoot];
            if (foundEffect !== effect) {
              rootsToRemove.push(foundRoot);
              const effectIndex = effects.indexOf(foundEffect);
              if (effectIndex >= 0) effects.splice(effectIndex, 1);
            }
          }
          // If this root contains the found root (and they map to different effects),
          // the found root is more specific, so don't add this one
          else if (root.includes(foundRoot) && foundRoot !== root) {
            const foundEffect = EFFECT_ROOTS[foundRoot];
            if (foundEffect !== effect) {
              shouldAdd = false;
              break;
            }
          }
        }
        
        // Remove the less specific roots from foundRoots
        rootsToRemove.forEach(r => foundRoots.delete(r));
        
        if (shouldAdd && !effects.includes(effect)) {
          effects.push(effect);
          foundRoots.add(root);
        }
      }
    }
    
    return effects;
  };

  // Parse a single shell description
  const parseShellDescription = (description) => {
    // Remove number prefixes (e.g., "1.", "1#", "1-", "1)", "2.", "#1", etc.)
    let cleanedDescription = description
      .replace(/^\d+[#.)\-]\s*/, '') // Remove patterns like "1.", "1#", "1)", "1-"
      .replace(/^#\d+\s*/, '') // Remove patterns like "#1"
      .replace(/^\d+\s+/, '') // Remove standalone numbers followed by space at start
      .trim();
    
    // If nothing was removed, try the split method as fallback
    if (cleanedDescription === description.trim()) {
      cleanedDescription = description.split(/^\d+[#.)\-]\s*/)[1] || description;
    }
    const colors = [];
    const effects = [];

    // Handle "to" pattern (transition): "X to Y" - get colors and effects from both parts
    if (cleanedDescription.toLowerCase().includes(' to ')) {
      const parts = cleanedDescription.split(/ to /i);
      parts.forEach(part => {
        const partColors = parseColors(part);
        partColors.forEach(color => {
          if (!colors.includes(color)) colors.push(color);
        });
        const partEffects = parseEffects(part);
        partEffects.forEach(eff => {
          if (!effects.includes(eff)) effects.push(eff);
        });
      });
    } 
    // Handle "with" pattern: "X with Y" - combine both parts
    else if (cleanedDescription.toLowerCase().includes(' with ')) {
      const parts = cleanedDescription.split(/ with /i);
      parts.forEach(part => {
        const partColors = parseColors(part);
        partColors.forEach(color => {
          if (!colors.includes(color)) colors.push(color);
        });
        const partEffects = parseEffects(part);
        partEffects.forEach(eff => {
          if (!effects.includes(eff)) effects.push(eff);
        });
      });
    }
    // Handle "wth" typo
    else if (cleanedDescription.toLowerCase().includes(' wth ')) {
      const parts = cleanedDescription.split(/ wth /i);
      parts.forEach(part => {
        const partColors = parseColors(part);
        partColors.forEach(color => {
          if (!colors.includes(color)) colors.push(color);
        });
        const partEffects = parseEffects(part);
        partEffects.forEach(eff => {
          if (!effects.includes(eff)) effects.push(eff);
        });
      });
    }
    // Handle "and" pattern: "X and Y" - combine both parts
    else if (cleanedDescription.toLowerCase().includes(' and ')) {
      const parts = cleanedDescription.split(/ and /i);
      parts.forEach(part => {
        const partColors = parseColors(part);
        partColors.forEach(color => {
          if (!colors.includes(color)) colors.push(color);
        });
        const partEffects = parseEffects(part);
        partEffects.forEach(eff => {
          if (!effects.includes(eff)) effects.push(eff);
        });
      });
    }
    // Simple case - parse entire description
    else {
      const parsedColors = parseColors(cleanedDescription);
      colors.push(...parsedColors);
      const parsedEffects = parseEffects(cleanedDescription);
      effects.push(...parsedEffects);
    }

    // If no colors found, add white as default
    if (colors.length === 0) {
      colors.push('#FFFFFF');
    }

    return { colors, effects };
  };

  // Parse using AI API
  const parseWithAI = async (text) => {
    try {
      const response = await axios.post('/api/inventory/parse-shell-descriptions', {
        descriptions: text,
        apiKey: apiKey || undefined // Only send if provided
      });
      return response.data;
    } catch (error) {
      console.error('AI parsing failed:', error);
      throw error;
    }
  };

  // Save API key to localStorage
  const handleApiKeyChange = (key) => {
    setApiKey(key);
    if (typeof window !== 'undefined') {
      if (key) {
        localStorage.setItem('openai_api_key', key);
      } else {
        localStorage.removeItem('openai_api_key');
      }
    }
  };

  // Handle quick add
  const handleQuickAdd = async () => {
    if (!quickAddText.trim()) return;

    setIsParsing(true);
    try {
      let parsedShells = [];

      if (useAIParser) {
        // Use AI parser
        const result = await parseWithAI(quickAddText);
        parsedShells = result.shells || [];
      } else {
        // Use local parser
        const lines = quickAddText.split('\n').filter(line => line.trim());
        parsedShells = lines.map((line, index) => {
          // Remove number prefixes (e.g., "1.", "1#", "1-", "1)", "2.", "#1", etc.)
          let cleanedLine = line.trim()
            .replace(/^\d+[#.)\-]\s*/, '') // Remove patterns like "1.", "1#", "1)", "1-"
            .replace(/^#\d+\s*/, '') // Remove patterns like "#1"
            .replace(/^\d+\s+/, '') // Remove standalone numbers followed by space at start
            .trim();
          
          // If nothing was removed, try the split method as fallback
          if (cleanedLine === line.trim()) {
            cleanedLine = line.trim().split(/^\d+[#.)\-]\s*/)[1] || line.trim();
          }
          
          const parsed = parseShellDescription(cleanedLine);
          return {
            number: index + 1,
            description: cleanedLine,
            colors: parsed.colors,
            effects: parsed.effects
          };
        });
      }

      if (parsedShells.length > 0) {
        // Limit to 24 shells
        const limitedShells = parsedShells.slice(0, 24);
        setShells(limitedShells);
        setShellCount(limitedShells.length);
        setQuickAddText('');
        setShowQuickAdd(false);
      } else {
        alert('No shells could be parsed from the input. Please check the format.');
      }
    } catch (error) {
      console.error('Failed to parse shells:', error);
      alert('Failed to parse shells. Please try again or use the local parser.');
    } finally {
      setIsParsing(false);
    }
  };

  // Save shell pack data
  const handleSave = async () => {
    if (!item || !item.id) return;

    try {
      // Get current metadata
      let metadata = {};
      if (item.metadata) {
        try {
          metadata = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;
        } catch (e) {
          console.error('Failed to parse existing metadata:', e);
        }
      }

      // Update pack_shell_data
      metadata.pack_shell_data = {
        shells: shells.map((shell, index) => ({
          number: index + 1,
          description: shell.description || '',
          colors: shell.colors,
          effects: shell.effects
        }))
      };

      // Update the item
      await updateInventoryItem(item.id, {
        ...item,
        metadata: JSON.stringify(metadata)
      });

      // Refresh inventory
      await fetchInventory();
      
      onClose();
    } catch (error) {
      console.error('Failed to save shell pack data:', error);
      alert('Failed to save shell pack data. Please try again.');
    }
  };

  if (!isOpen || !item) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-gray-800 text-white p-6 rounded shadow-lg w-11/12 max-w-6xl max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-2xl font-bold">Shell Pack Editor - {item.name}</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white text-2xl"
          >
            ×
          </button>
        </div>

        {/* Quick Add Section */}
        <div className="mb-6 p-4 bg-gray-700 rounded-lg">
          <div className="flex justify-between items-center mb-2">
            <button
              onClick={() => setShowQuickAdd(!showQuickAdd)}
              className="text-blue-400 hover:text-blue-300 font-semibold"
            >
              {showQuickAdd ? '▼' : '▶'} Quick Add
            </button>
            {showQuickAdd && (
              <div className="flex items-center gap-4">
                <label className="flex items-center text-gray-300 text-sm">
                  <input
                    type="checkbox"
                    checked={useAIParser}
                    onChange={(e) => setUseAIParser(e.target.checked)}
                    className="mr-2"
                  />
                  Use AI Parser
                </label>
                {useAIParser && (
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => handleApiKeyChange(e.target.value)}
                    placeholder="OpenAI API Key (or set OPENAI_API_KEY env var)"
                    className="flex-1 max-w-md px-3 py-1 bg-gray-800 text-white border border-gray-600 rounded text-sm"
                  />
                )}
              </div>
            )}
          </div>
          {showQuickAdd && (
            <div className="space-y-2">
              <p className="text-gray-300 text-sm">
                Paste shell descriptions (one per line). Examples: "Lemon Orange Peony to Silver Strobes", "Red Coconut Palm with Green Strobes"
              </p>
              <textarea
                value={quickAddText}
                onChange={(e) => setQuickAddText(e.target.value)}
                placeholder="Lemon Orange Peony to Silver Strobes&#10;Silver Coconut Palm with Red Strobes&#10;Red Peony to Orange with White Strobes"
                className="w-full h-48 p-3 bg-gray-800 text-white border border-gray-600 rounded focus:outline-none focus:border-blue-500"
              />
              <button
                onClick={handleQuickAdd}
                disabled={isParsing}
                className="bg-green-600 hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white px-4 py-2 rounded"
              >
                {isParsing ? 'Parsing...' : 'Parse and Create Shells'}
              </button>
            </div>
          )}
        </div>

        {/* Shell Count Selector */}
        <div className="mb-6">
          <label className="block text-gray-200 text-sm font-bold mb-2">
            Number of Shells (1-24):
          </label>
          <input
            type="number"
            min="1"
            max="24"
            value={shellCount}
            onChange={(e) => handleShellCountChange(e.target.value)}
            className="shadow appearance-none border rounded w-32 py-2 px-3 text-white bg-gray-700 border-gray-600 leading-tight focus:outline-none focus:shadow-outline"
          />
        </div>

        {/* Shells Table */}
        <div className="overflow-x-auto mb-6">
          <table className="w-full border-collapse border border-gray-600">
            <thead>
              <tr className="bg-gray-700">
                <th className="border border-gray-600 px-4 py-2 text-left">#</th>
                <th className="border border-gray-600 px-4 py-2 text-left">Description</th>
                <th className="border border-gray-600 px-4 py-2 text-left">Colors</th>
                <th className="border border-gray-600 px-4 py-2 text-left">Effects</th>
              </tr>
            </thead>
            <tbody>
              {shells.map((shell, shellIndex) => (
                <tr key={shellIndex} className={shellIndex % 2 === 0 ? 'bg-gray-800' : 'bg-gray-900'}>
                  <td className="border border-gray-600 px-4 py-2 font-bold">
                    #{shellIndex + 1}
                  </td>
                  <td className="border border-gray-600 px-4 py-2">
                    <input
                      type="text"
                      value={shell.description || ''}
                      onChange={(e) => {
                        const newShells = [...shells];
                        newShells[shellIndex].description = e.target.value;
                        setShells(newShells);
                      }}
                      placeholder="Shell description..."
                      className="w-full px-2 py-1 bg-gray-800 text-white border border-gray-600 rounded text-sm"
                    />
                  </td>
                  <td className="border border-gray-600 px-4 py-2">
                    <div className="flex flex-wrap gap-2 items-center">
                      {shell.colors.map((color, colorIndex) => (
                        <div key={colorIndex} className="flex items-center gap-2">
                          <input
                            type="color"
                            value={color}
                            onChange={(e) => updateColor(shellIndex, colorIndex, e.target.value)}
                            className="w-10 h-10 border border-gray-500 rounded cursor-pointer"
                          />
                          <button
                            onClick={() => removeColor(shellIndex, colorIndex)}
                            className="text-red-400 hover:text-red-300 text-xl"
                            title="Remove color"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                      <button
                        onClick={() => addColor(shellIndex)}
                        className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded text-sm font-bold"
                        title="Add color"
                      >
                        +
                      </button>
                    </div>
                  </td>
                  <td className="border border-gray-600 px-4 py-2">
                    <div className="space-y-2">
                      {/* Display current effects */}
                      {shell.effects.length > 0 && (
                        <div className="flex flex-wrap gap-2 mb-2">
                          {shell.effects.map((effect, effectIndex) => (
                            <div
                              key={effectIndex}
                              className="flex items-center gap-1 bg-blue-600 text-white px-2 py-1 rounded text-sm"
                            >
                              <span>{effect}</span>
                              <button
                                onClick={() => removeEffectFromShell(shellIndex, effectIndex)}
                                className="text-red-200 hover:text-white text-lg font-bold"
                                title="Remove effect"
                              >
                                ×
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      {/* Add effect dropdown */}
                      <div className="flex items-center gap-2">
                        <select
                          value={selectedEffectToAdd[shellIndex] || ''}
                          onChange={(e) => setSelectedEffectToAdd({ ...selectedEffectToAdd, [shellIndex]: e.target.value })}
                          className="flex-1 px-2 py-1 bg-gray-800 text-white border border-gray-600 rounded text-sm"
                        >
                          <option value="">Select effect...</option>
                          {EFFECT_OPTIONS.filter(effect => !shell.effects.includes(effect)).map((effect) => (
                            <option key={effect} value={effect}>
                              {effect}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => addEffectToShell(shellIndex)}
                          disabled={!selectedEffectToAdd[shellIndex]}
                          className="bg-green-600 hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white px-3 py-1 rounded text-sm font-bold"
                          title="Add selected effect"
                        >
                          Add
                        </button>
                      </div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Action Buttons */}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="bg-gray-600 hover:bg-gray-700 text-white px-6 py-2 rounded"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
