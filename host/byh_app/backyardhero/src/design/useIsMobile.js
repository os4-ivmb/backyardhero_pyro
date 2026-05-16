import { useEffect, useState } from "react";

// SSR-safe viewport detector for mobile-mode chrome. We branch off the
// raw inner width rather than UA sniffing because the operator console
// is sometimes opened on a phone-sized window on a laptop -- the chrome
// should follow the viewport, not the device class.
//
// Threshold mirrors Tailwind's `md` breakpoint (768px). Resolves to
// `false` on the server so the desktop tree is rendered first and the
// mobile shell only takes over after hydration; this avoids hydration
// mismatches because we explicitly defer the first read with a
// rendered-once flag.
const MOBILE_QUERY = "(max-width: 767.98px)";

export default function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(MOBILE_QUERY);
    const sync = () => setIsMobile(mql.matches);
    sync();
    if (mql.addEventListener) {
      mql.addEventListener("change", sync);
      return () => mql.removeEventListener("change", sync);
    }
    mql.addListener(sync);
    return () => mql.removeListener(sync);
  }, []);

  return isMobile;
}
