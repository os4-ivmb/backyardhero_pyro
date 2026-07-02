import React from "react";

// Static reference of the timeline / editor controls. Purely informational —
// no state, no props. Kept in its own tab so operators can look up a gesture
// without leaving the builder.

// A single keycap / gesture chip.
const Key = ({ children }) => (
  <kbd className="inline-flex items-center rounded-sm border border-border-subtle bg-surface-3 px-1.5 py-0.5 text-[11px] font-medium leading-none text-fg-primary shadow-e1 whitespace-nowrap">
    {children}
  </kbd>
);

// One control row: the gesture (a sequence of keys/chips) + what it does.
const Row = ({ keys, children }) => (
  <div className="flex items-start gap-3 py-1.5 border-b border-border-subtle/60 last:border-b-0">
    <div className="flex items-center gap-1 shrink-0 w-52 flex-wrap">
      {keys.map((k, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="text-fg-muted text-[11px]">+</span>}
          <Key>{k}</Key>
        </React.Fragment>
      ))}
    </div>
    <div className="text-sm text-fg-secondary pt-0.5">{children}</div>
  </div>
);

const Section = ({ title, children }) => (
  <div className="mb-6">
    <h3 className="eyebrow mb-1.5 text-fg-muted">{title}</h3>
    <div className="rounded-md border border-border-subtle bg-surface-1/60 px-3 py-1">
      {children}
    </div>
  </div>
);

const ControlsTab = () => {
  return (
    <div className="max-w-3xl">
      <p className="text-sm text-fg-secondary mb-5">
        Mouse and keyboard controls for the timeline. Modifier keys are shown as
        they behave on the current wheel mode (toggle{" "}
        <span className="font-medium text-fg-primary">Scroll zoom</span> in the
        timeline toolbar to swap the wheel's default between panning and zooming).
      </p>

      <Section title="Zoom & scroll">
        <Row keys={["Scroll"]}>Pan the timeline horizontally.</Row>
        <Row keys={["Shift", "Scroll"]}>Zoom in / out.</Row>
        <Row keys={["Alt", "Scroll"]}>
          Scroll vertically through stacked rows (virtual scroll).
        </Row>
        <Row keys={["Pinch"]}>
          Two-finger pinch to zoom in / out on a touchscreen.
        </Row>
        <Row keys={["+", "−"]}>
          The toolbar zoom buttons step the zoom in / out; the readout between
          them shows the current level.
        </Row>
        <Row keys={["Scroll zoom"]}>
          When enabled: a bare <Key>Scroll</Key> zooms, <Key>Shift</Key> +{" "}
          <Key>Scroll</Key> pans horizontally, and <Key>Alt</Key> still scrolls
          vertically.
        </Row>
      </Section>

      <Section title="Placing & editing cues">
        <Row keys={["Double-click"]}>Add an item at the clicked time.</Row>
        <Row keys={["Shift", "Double-click"]}>
          Insert an item — every cue at or after that time shifts back to make
          room for the new one.
        </Row>
        <Row keys={["Drag from Inventory"]}>
          Drag a row from the Inventory tab onto the timeline to add that item
          at the drop time.
        </Row>
        <Row keys={["Drag"]}>Move an item along the timeline.</Row>
        <Row keys={["Alt", "Drag"]}>Bypass snap while dragging for fine adjustment.</Row>
        <Row keys={["Drag selection"]}>
          With several items selected, dragging any one of them moves the whole
          selection together (locked cues stay put).
        </Row>
        <Row keys={["✕ button"]}>
          Click the ✕ on an item's label to remove it (confirms first).
        </Row>
        <Row keys={["Right-click item"]}>
          Context menu — Edit, Start at, End at, Swap with, Copy to, Lock /
          Unlock, Delete.
        </Row>
        <Row keys={["Right-click empty"]}>Add inventory at that time.</Row>
      </Section>

      <Section title="Selection">
        <Row keys={["Click"]}>Select a single item.</Row>
        <Row keys={["Ctrl / ⌘", "Click"]}>Add or remove an item from the selection.</Row>
        <Row keys={["Click empty"]}>
          Clear the selection / move the time cursor.
        </Row>
        <Row keys={["Hover 1s"]}>Show an item's start & end time tooltip.</Row>
      </Section>

      <Section title="Playback & saving">
        <Row keys={["Space"]}>
          Play / pause audio (ignored while typing in a field).
        </Row>
        <Row keys={["Ctrl / ⌘", "S"]}>Save the show.</Row>
      </Section>

      <Section title="Grid & snap">
        <Row keys={["Grid"]}>
          Switch gridlines between seconds and song beats (beats need a detected
          BPM).
        </Row>
        <Row keys={["Snap"]}>
          (Seconds mode) Snap dragged cues to the chosen time grid.
        </Row>
        <Row keys={["Snap to beat"]}>
          (Beats mode) Snap dragged cues to the nearest beat.
        </Row>
      </Section>

      <Section title="Toolbar toggles">
        <Row keys={["Show zone:cue"]}>
          Show the zone:cue badge (e.g. RX142:1) on each item's label.
        </Row>
        <Row keys={["Show start time"]}>Show each cue's start time on its label.</Row>
        <Row keys={["Show end time"]}>Show each cue's end time on its label.</Row>
        <Row keys={["Compact view"]}>
          Smaller item bars; uncheck for taller bars with larger labels.
        </Row>
        <Row keys={["Follow playhead"]}>
          Keep the playhead framed during playback. Turns off automatically when
          you scroll the timeline manually.
        </Row>
      </Section>
    </div>
  );
};

export default ControlsTab;
