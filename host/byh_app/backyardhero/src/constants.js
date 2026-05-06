export const INV_TYPES = {
    CAKE_FOUNTAIN: 'Fountain Cake',
    CAKE_200G: '200G Cake',
    CAKE_350G: '350G Cake',
    CAKE_500G: '500G Cake',
    COMPOUND_CAKE: 'Compound',
    AERIAL_SHELL: 'AERIAL SHELL',
    GENERIC: 'Generic',
    FUSE: 'Fuse'
}

export const SPECIAL_TYPES = {
    FUSED_AERIAL_LINE: "Fused Shells",
    FUSED_LINE: "Fused Item Line"
}

// Display labels for every item type the show builder/loadout knows about.
// Use `getTypeLabel(type)` rather than reading this map directly — the helper
// falls back to a sensible Title-Cased form for unknown types.
export const TYPE_LABELS = {
    CAKE_FOUNTAIN: 'Fountain Cake',
    CAKE_200G: '200g Cake',
    CAKE_350G: '350g Cake',
    CAKE_500G: '500g Cake',
    COMPOUND_CAKE: 'Compound Cake',
    AERIAL_SHELL: 'Aerial Shell',
    GENERIC: 'Generic',
    FUSE: 'Fuse',
    FUSED_AERIAL_LINE: 'Fused Shell Line',
    FUSED_SHELL_LINE: 'Fused Shell Line',
    FUSED_LINE: 'Fused Line',
    RACK_SHELLS: 'Rack Shells',
}

export const getTypeLabel = (type) => {
    if (!type) return '';
    if (TYPE_LABELS[type]) return TYPE_LABELS[type];
    // Fallback: turn FOO_BAR_BAZ into "Foo Bar Baz".
    return String(type)
        .toLowerCase()
        .split('_')
        .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
        .join(' ');
}

export const INV_COLOR_CODE = {
    CAKE_FOUNTAIN: '#AAAA33',
    CAKE_200G: '#33AAAA',
    CAKE_350G: '#33CCAA',
    CAKE_500G: '#26b0ff',
    COMPOUND_CAKE: '#c026d3',
    AERIAL_SHELL: '#FF0000',
    GENERIC: '#FFFFFF',
    FUSE: '#00FF00',
    FUSED_AERIAL_LINE: '#23cf53',
    FUSED_SHELL_LINE: '#23cf53',
    FUSED_LINE: '#f59e0b',
    RACK_SHELLS: '#FF8C00'
}