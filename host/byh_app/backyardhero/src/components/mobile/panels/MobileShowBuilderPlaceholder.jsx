import React from "react";
import { FaLaptop, FaTabletScreenButton } from "react-icons/fa6";
import { Card, Section } from "@/design";

// The show builder is the single mobile-incompatible feature: it relies
// on a satellite map, drag-and-drop racks, fine-grained timeline cells,
// and a live audio waveform. Squeezing all of that into a phone-width
// viewport would be misleading -- we'd ship a UI that looks usable but
// can't actually compose a real show. The placeholder explicitly tells
// the operator to come back on a tablet or laptop.
export default function MobileShowBuilderPlaceholder() {
  return (
    <div className="w-full px-4 py-6">
      <Section
        title="Show Editor"
        description="The visual editor isn't available on mobile."
      >
        <Card padding="lg" tone="neutral" className="text-center">
          <div className="mx-auto mb-3 inline-flex items-center justify-center gap-3">
            <FaTabletScreenButton className="text-3xl text-fg-secondary" aria-hidden />
            <span className="text-fg-muted">+</span>
            <FaLaptop className="text-3xl text-fg-secondary" aria-hidden />
          </div>
          <h3 className="text-lg font-semibold text-fg-primary">
            Use a tablet or laptop
          </h3>
          <p className="mt-2 text-sm text-fg-secondary max-w-md mx-auto">
            The show builder needs a wider screen for the timeline, satellite
            map, and rack layout tools. Open this page on a tablet or laptop
            to design or edit shows.
          </p>
          <p className="mt-3 text-xs text-fg-muted max-w-md mx-auto">
            You can still stage, load, and run an existing show from this
            phone -- everything else in the app is available here.
          </p>
        </Card>
      </Section>
    </div>
  );
}
