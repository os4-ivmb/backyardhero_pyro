import React from "react";
import ManualFirePanel from "../../manualFire/ManualFirePanel";

// The desktop ManualFirePanel is already grid-based with thumb-sized
// fire buttons (h-20, 3-up at the smallest breakpoint), so the mobile
// wrapper just provides a tighter outer gutter -- no re-implementation
// needed. The gate pattern (no protocol / key not turned / arm switch
// off) is identical on phone and desktop.
export default function MobileManualFiring() {
  return (
    <div className="w-full px-3 py-4">
      <ManualFirePanel />
    </div>
  );
}
