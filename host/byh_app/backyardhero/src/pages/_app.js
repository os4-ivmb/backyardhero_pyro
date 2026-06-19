import "@/styles/globals.css";
import { Inter, JetBrains_Mono } from "next/font/google";
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
const sans = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
});

export default function App({ Component, pageProps }) {
  // Desktop (Electron) only: repair keyboard focus after native dialogs so
  // typing keeps working after a confirm/alert (e.g. deleting a receiver).
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
