export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { descriptions } = req.body;

  if (!descriptions || typeof descriptions !== 'string') {
    return res.status(400).json({ error: 'Descriptions text is required' });
  }

  try {
    // Check if OpenAI API key is configured (from env or request body)
    const openaiApiKey = req.body.apiKey || process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      return res.status(400).json({ 
        error: 'OpenAI API key not configured. Please set OPENAI_API_KEY environment variable or pass apiKey in request body.' 
      });
    }

    const lines = descriptions.split('\n').filter(line => line.trim());
    
    const prompt = `You are a firework shell description parser. Parse the following shell descriptions and return a JSON array.

Each description should be parsed into an object with:
- number: the shell number (1-based index)
- description: the original text description for this shell, but REMOVE any leading number prefixes like "1.", "1#", "1)", or similar number patterns at the start of the description. Keep only the actual description text.
- colors: array of hex color codes (e.g., ["#FFFF00", "#FFA500"])
- effects: array of effect names from the list below (use underscores, not spaces). Extract ALL effects mentioned in the description and map them to the most appropriate type from the available list. Be thorough and don't miss any effects.

AVAILABLE EFFECT TYPES (choose the most appropriate from this list):
PEONY, CHRYSANTHEMUM, BROCADE, BROCADE_CROWN, WILLOW, KAMURO, PALM, HORSETAIL, CURTAIN, WATERFALL, RING, DOUBLE_RING, TRIPLE_RING, PATTERN, GEOMETRIC, SHAPE, HEART, LETTER, LOGO, DOUBLE_BREAK, TRIPLE_BREAK, MULTI_BREAK, TIME_BREAK, DELAYED_BREAK, CRACKLE, DRAGON_EGG, MICRO_CRACKLE, BROKEN, DIRTY, IRREGULAR, COMET, RISING_TAIL, FALLING_TAIL, SPINNER, TOURBILLON, SWIRL, STROBE, GLITTER, TIME_RAIN, COLOR_CHANGE, FLASH, NISHIKI, NISHIKI_WILLOW, NISHIKI_KAMURO, NISHIKI_BROCADE, COCONUT, MEATBALL, CHUNKY, SALUTE, REPORT, CROWN, HALO, GHOST, SMOKE, TAIL, DAHLIA, WAVE, WHISTLING

Use your best judgment to map effects from the description to the most appropriate type from the list above. Be flexible and creative in your mapping - if a description mentions an effect that could map to multiple types, choose the one that best fits. Some general guidance (but feel free to deviate if it makes more sense):
- Peony-like effects (peony, pearls, dahlia, plum blossoms) -> typically PEONY or DAHLIA
- Brocade effects -> BROCADE or BROCADE_CROWN
- Palm effects -> PALM or COCONUT
- Strobes/strobe effects -> STROBE (distinct from crackle)
- Crackles/crackling -> CRACKLE (distinct from strobe)
- Glitter/glittering -> GLITTER (be sure to include this if mentioned)
- Ring effects -> RING, DOUBLE_RING, or TRIPLE_RING based on context
- Break effects -> MULTI_BREAK, DOUBLE_BREAK, TRIPLE_BREAK, TIME_BREAK, or DELAYED_BREAK based on description
- Nishiki effects -> NISHIKI, NISHIKI_WILLOW, NISHIKI_KAMURO, or NISHIKI_BROCADE
- Tail effects -> TAIL, RISING_TAIL, or FALLING_TAIL
- Spinning effects -> SPINNER, TOURBILLON, or SWIRL

The key is to extract ALL effects mentioned and map them to the most appropriate type from the list. Use your understanding of firework terminology to make the best match.

Color mappings:
- lemon, yellow -> #FFFF00
- orange -> #FFA500
- silver -> #C0C0C0
- red -> #FF0000
- blue -> #0000FF
- white -> #FFFFFF
- green -> #008000
- purple -> #800080
- titanium -> #FFFFFF
- deep red, deepred -> #8B0000

For descriptions with "to" (e.g., "X to Y"), extract colors and effects from both parts.
For descriptions with "with" or "and" (e.g., "X with Y"), combine colors and effects from both parts.

IMPORTANT: Be thorough when extracting effects. Read the entire description carefully and extract ALL effects mentioned, even if they appear in different forms or variations. Use your judgment to map them to the most appropriate type from the available list.

IMPORTANT: For the description field, remove any leading number prefixes (like "1.", "1#", "1)", "2.", etc.) from the beginning of each description. Only include the actual description text.

Return ONLY a valid JSON object with a "shells" key containing an array, no other text. Example format:
{
  "shells": [
    {"number": 1, "description": "Lemon Orange Peony to Silver Strobes", "colors": ["#FFFF00", "#FFA500"], "effects": ["PEONY", "STROBE"]},
    {"number": 2, "description": "Silver Coconut Palm with Red Strobes", "colors": ["#C0C0C0"], "effects": ["PALM", "STROBE"]}
  ]
}

CRITICAL: If the input description contains a leading number prefix like "1.", "1#", "1)", "1-", "#1", or just "1 " at the start, you MUST remove it from the description field. Only include the actual description text without any numbering.

Shell descriptions:
${lines.map((line) => line.trim()).join('\n')}

Return the JSON array:`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o', // Using gpt-4o for better accuracy and instruction following
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant that parses firework shell descriptions and returns only valid JSON arrays, no other text. Always follow instructions precisely, especially regarding removing number prefixes from descriptions.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.1, // Low temperature for consistent, deterministic output
        max_tokens: 2000,
        response_format: { type: 'json_object' } // Force JSON output format
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error('OpenAI API error:', errorData);
      return res.status(500).json({ 
        error: 'Failed to parse with AI. Please try the local parser instead.' 
      });
    }

    const data = await response.json();
    const content = data.choices[0]?.message?.content?.trim();

    if (!content) {
      return res.status(500).json({ error: 'No response from AI' });
    }

    // Parse JSON response - should be an object with "shells" array
    let parsedData;
    try {
      parsedData = JSON.parse(content);
    } catch (e) {
      // Try to extract JSON from markdown code blocks or other wrappers
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsedData = JSON.parse(jsonMatch[0]);
      } else {
        // Fallback: try to find array
        const arrayMatch = content.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
          parsedData = { shells: JSON.parse(arrayMatch[0]) };
        } else {
          throw new Error('Could not parse JSON from response');
        }
      }
    }

    const parsedShells = parsedData.shells || parsedData;
    
    if (!Array.isArray(parsedShells)) {
      return res.status(500).json({ error: 'Invalid response format from AI - expected array of shells' });
    }

    // Validate and normalize the parsed shells
    const normalizedShells = parsedShells.map((shell, index) => {
      let description = shell.description || lines[index] || '';
      // Remove leading number prefixes (1., 1#, 1), 1-, etc.) - be more aggressive
      description = description
        .replace(/^\d+[.#)\-]\s*/, '') // Remove patterns like "1.", "1#", "1)", "1-"
        .replace(/^#\d+\s*/, '') // Remove patterns like "#1"
        .replace(/^\d+\s*/, '') // Remove standalone numbers at start
        .trim();
      
      return {
        number: index + 1,
        description: description,
        colors: Array.isArray(shell.colors) ? shell.colors : [],
        effects: Array.isArray(shell.effects) ? shell.effects : []
      };
    });

    return res.status(200).json({ shells: normalizedShells });
  } catch (error) {
    console.error('Error parsing shell descriptions:', error);
    return res.status(500).json({ 
      error: 'Failed to parse shell descriptions: ' + error.message 
    });
  }
}

