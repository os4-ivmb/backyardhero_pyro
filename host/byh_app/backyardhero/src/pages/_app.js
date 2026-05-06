import "@/styles/globals.css";
import { Inter, JetBrains_Mono } from "next/font/google";

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
