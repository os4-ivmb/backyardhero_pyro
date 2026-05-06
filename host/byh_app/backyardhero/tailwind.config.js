/** @type {import('tailwindcss').Config} */

const withOpacity = (variable) => ({ opacityValue }) =>
  opacityValue === undefined
    ? `rgb(var(${variable}))`
    : `rgb(var(${variable}) / ${opacityValue})`;

module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      // Semantic colors. Driven by CSS variables defined in globals.css so
      // the chrome can swing per operational mode (armed, live, ...) by
      // swapping a single root class instead of a hundred component edits.
      colors: {
        // Layered surfaces, dark-only console palette.
        surface: {
          base: withOpacity("--surface-base"),
          1: withOpacity("--surface-1"),
          2: withOpacity("--surface-2"),
          3: withOpacity("--surface-3"),
          inset: withOpacity("--surface-inset"),
        },
        border: {
          subtle: withOpacity("--border-subtle"),
          DEFAULT: withOpacity("--border-default"),
          strong: withOpacity("--border-strong"),
        },
        fg: {
          primary: withOpacity("--fg-primary"),
          secondary: withOpacity("--fg-secondary"),
          muted: withOpacity("--fg-muted"),
          disabled: withOpacity("--fg-disabled"),
          oncritical: withOpacity("--fg-oncritical"),
        },
        accent: {
          DEFAULT: withOpacity("--accent"),
          fg: withOpacity("--accent-fg"),
          muted: withOpacity("--accent-muted"),
        },
        // Semantic state colors. Used sparingly: only abnormal states get
        // saturated treatment; normal-OK should be neutral or pale-success.
        ok: {
          DEFAULT: withOpacity("--ok"),
          fg: withOpacity("--ok-fg"),
          bg: withOpacity("--ok-bg"),
        },
        warn: {
          DEFAULT: withOpacity("--warn"),
          fg: withOpacity("--warn-fg"),
          bg: withOpacity("--warn-bg"),
        },
        danger: {
          DEFAULT: withOpacity("--danger"),
          fg: withOpacity("--danger-fg"),
          bg: withOpacity("--danger-bg"),
        },
        // The "armed" semantic (high-attention but not yet error). Used for
        // ARMED chrome / live-fire imminent indicators.
        armed: {
          DEFAULT: withOpacity("--armed"),
          fg: withOpacity("--armed-fg"),
          bg: withOpacity("--armed-bg"),
        },
        live: {
          DEFAULT: withOpacity("--live"),
          fg: withOpacity("--live-fg"),
          bg: withOpacity("--live-bg"),
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: [
          "var(--font-mono)",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      fontSize: {
        // Tighter type scale; most ops UI sits at 13/15.
        "2xs": ["10px", { lineHeight: "14px", letterSpacing: "0.04em" }],
        xs: ["11px", { lineHeight: "16px", letterSpacing: "0.02em" }],
        sm: ["13px", { lineHeight: "18px" }],
        base: ["14px", { lineHeight: "20px" }],
        lg: ["16px", { lineHeight: "22px" }],
        xl: ["18px", { lineHeight: "24px" }],
        "2xl": ["22px", { lineHeight: "28px" }],
        "3xl": ["28px", { lineHeight: "32px", letterSpacing: "-0.01em" }],
        display: [
          "40px",
          { lineHeight: "44px", letterSpacing: "-0.02em", fontWeight: "600" },
        ],
      },
      borderRadius: {
        none: "0",
        xs: "2px",
        sm: "4px",
        DEFAULT: "6px",
        md: "8px",
        lg: "12px",
        xl: "16px",
      },
      spacing: {
        // Add a consistent gutter scale; tailwind already covers most.
        18: "4.5rem",
      },
      boxShadow: {
        // Subtle elevations only -- no neon glows in the default skin.
        e1: "0 1px 0 0 rgb(var(--border-subtle) / 1)",
        e2: "0 1px 2px 0 rgb(0 0 0 / 0.4)",
        e3: "0 4px 12px 0 rgb(0 0 0 / 0.5)",
        // Inset border for "card" surfaces.
        inset: "inset 0 0 0 1px rgb(var(--border-default) / 1)",
        "inset-strong": "inset 0 0 0 1px rgb(var(--border-strong) / 1)",
        // Mode-keyed glows reserved for ARMED / LIVE / DANGER.
        armed: "0 0 0 1px rgb(var(--armed) / 0.6), 0 0 24px 0 rgb(var(--armed) / 0.25)",
        danger: "0 0 0 1px rgb(var(--danger) / 0.6), 0 0 24px 0 rgb(var(--danger) / 0.20)",
        live: "0 0 0 1px rgb(var(--live) / 0.6), 0 0 24px 0 rgb(var(--live) / 0.20)",
      },
      transitionTimingFunction: {
        snap: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      },
      keyframes: {
        // Subtle "live" pulse used for imminent-fire indicators. Slow and
        // restrained -- not the strobing neon of the previous design.
        livePulse: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.55" },
        },
        // Indeterminate progress sweep on START_PENDING / loading bars.
        sweep: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" },
        },
      },
      animation: {
        livePulse: "livePulse 1.6s ease-in-out infinite",
        sweep: "sweep 1.6s linear infinite",
      },
    },
  },
  plugins: [],
};
