import React from "react";
import ManualFirePanel from "../../manualFire/ManualFirePanel";

// Phone layout stacks the selected receiver's fire grid above the
// receiver list. Cue buttons stay thumb-sized. The gate pattern (no protocol / key not turned / arm
// switch off) is identical on phone and desktop.
export default function MobileManualFiring() {
  return (
    <div className="w-full px-3 py-4">
      <ManualFirePanel />
    </div>
  );
}
