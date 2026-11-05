import "@/styles/globals.css";
import localFont from "next/font/local";
import { useEffect } from "react";
import axios from "axios";
import { BASE_PATH } from "@/util/clientEnv";
import { installDesktopDialogFocusFix } from "@/util/desktopFocusFix";
import { AsyncPromptHost } from "@/components/common/AsyncPrompt";

// next/link, next/router and next/image apply basePath automatically, but raw
// axios/fetch calls do not. Point axios at the basePath so the existing
// `axios.get('/api/...')` call sites resolve under it (e.g. /builder/api/...).
// Local builds have BASE_PATH === '' so this is the axios default (no-op).
axios.defaults.baseURL = BASE_PATH;

// Inter for UI text (good at small sizes, tabular numerals available),
// JetBrains Mono for timing/numerics in tables, timeline labels, addrs.
// Files live in the repo: `next/font/google` downloads CSS at build time,
// and Google sometimes returns extensionless kit URLs that Next 16's
// Turbopack loader cannot parse, which fails the host image build.
const sans = localFont({
  src: "../fonts/inter-latin-wght-normal.woff2",
  weight: "100 900",
  display: "swap",
  variable: "--font-sans",
  adjustFontFallback: "Arial",
});
const mono = localFont({
  src: "../fonts/jetbrains-mono-latin-wght-normal.woff2",
  weight: "100 800",
  display: "swap",
  variable: "--font-mono",
  // Leave the fallback to the monospace stack in Tailwind. The default
  // size-adjust fallback is Arial, which reflows numeric columns.
  adjustFontFallback: false,
});

export default function App({ Component, pageProps }) {
  // Desktop (Electron) only: repair keyboard focus after any native dialog
  // that slips through. App code uses the in-app asyncAlert/asyncConfirm/
  // asyncPrompt modals (see AsyncPrompt.jsx) instead of window.alert/confirm/
  // prompt, since on macOS the native ones tear down and recreate the whole
  // window on dismiss, and on Windows they break keyboard focus.
  useEffect(() => {
    installDesktopDialogFocusFix();
  }, []);

  return (
    <div className={`${sans.variable} ${mono.variable} font-sans`}>
      <Component {...pageProps} />
      <AsyncPromptHost />
    </div>
  );
}
