import "@/styles/globals.css";
import { Inter, JetBrains_Mono } from "next/font/google";
import axios from "axios";
import { BASE_PATH } from "@/util/clientEnv";

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
  return (
    <div className={`${sans.variable} ${mono.variable} font-sans`}>
      <Component {...pageProps} />
    </div>
  );
}
