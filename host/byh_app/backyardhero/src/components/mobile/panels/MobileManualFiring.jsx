import React from "react";
import ManualFirePanel from "../../manualFire/ManualFirePanel";

// Phone layout stacks every active receiver (the desktop firing field
// needs the width to place racks left-to-right). Cue buttons stay
// thumb-sized. The gate pattern (no protocol / key not turned / arm
// switch off) is identical on phone and desktop.
export default function MobileManualFiring() {
  return (
    <div className="w-full px-3 py-4">
      <ManualFirePanel />
    </div>
  );
}
