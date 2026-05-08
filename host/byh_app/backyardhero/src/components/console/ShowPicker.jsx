import React, { useState, useMemo } from "react";
import axios from "axios";
import { FaMusic, FaTrashAlt } from "react-icons/fa";
import { FiPlay } from "react-icons/fi";

import useAppStore from "@/store/useAppStore";
import { Section, Card, Button, IconButton, Badge } from "@/design";
import { computeShowStats, formatShowCreatedAt } from "@/util/showStats";
import { parseAudioField } from "@/utils/audioTracks";

// Empty-state surface for the console: a clean picker for staging shows.
// Replaces:
//   - the "No Show Staged Yet!" copy + heavy table inside StatusPanel
//   - the slide-out ShowBrowser drawer that lived behind a `<` toggle
// Both anti-patterns from the brief: weak primary action and table chrome
// noise.

const formatDuration = (s) => {
  if (!s || !Number.isFinite(s)) return "—";
  const m = Math.floor(s / 60);
  const r = Math.round(s) % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
};

export default function ShowPicker() {
  const { shows, deleteShow, setStagedShow, inventoryById, loadedShow } = useAppStore();
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return shows;
    return shows.filter((s) => (s.name || "").toLowerCase().includes(q));
  }, [shows, filter]);

  const handleStage = (show) => {
    const items = JSON.parse(show.display_payload || "[]").map((pi) => ({
      ...inventoryById[pi.itemId],
      ...pi,
    }));
    let audioTracks = [];
    let audioFile = null;
    let audioOffsetMs = 0;
    if (show.audio_file) {
      try {
        const r = parseAudioField(JSON.parse(show.audio_file));
        audioTracks = r.tracks;
        audioOffsetMs = r.audioOffsetMs;
        audioFile = audioTracks[0] || null;
      } catch { /* tolerated */ }
    }
    setStagedShow({ ...show, items, audioFile, audioTracks, audioOffsetMs });
  };

  const handleDelete = async (e, show) => {
    e.stopPropagation();
    if (!window.confirm(`Delete show "${show.name}"?`)) return;
    deleteShow(show.id);
  };

  return (
    <div className="w-full max-w-5xl mx-auto px-4 sm:px-6 py-8">
      <Section
        title="Stage a show"
        description="Pick a saved show to stage. Staging arms the timeline and reveals the load workflow."
        actions={
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search shows…"
            className="h-9 w-56 px-3 rounded-sm bg-surface-1 border border-border text-sm text-fg-primary placeholder:text-fg-muted focus:border-accent"
          />
        }
      >
        {filtered.length === 0 ? (
          <Card padding="lg" tone="neutral" className="text-center">
            <p className="text-fg-secondary">
              {shows.length === 0
                ? "No shows yet. Build one in the Editor."
                : "No shows match your search."}
            </p>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {filtered.map((show) => {
              const isLoaded = loadedShow?.id === show.id;
              const stats = computeShowStats(show, inventoryById);
              return (
                <Card
                  key={show.id}
                  padding="md"
                  tone="neutral"
                  className="group hover:border-border-strong transition-colors flex flex-col gap-3"
                >
                  <div className="flex items-start justify-between gap-2 min-w-0">
                    <div className="min-w-0">
                      <h3 className="text-base font-semibold text-fg-primary truncate">
                        {show.name || "Untitled show"}
                      </h3>
                      <div className="flex items-center gap-2 mt-1 text-2xs text-fg-muted">
                        <span className="num">{formatDuration(show.duration)}</span>
                        {show.audio_file ? (
                          <>
                            <span>·</span>
                            <span className="inline-flex items-center gap-1 text-accent">
                              <FaMusic aria-hidden /> Audio
                            </span>
                          </>
                        ) : null}
                      </div>
                    </div>
                    {isLoaded ? <Badge tone="ok">Loaded</Badge> : null}
                  </div>

                  <ShowStatGrid stats={stats} />

                  <div className="flex items-center justify-between gap-2 mt-auto pt-2 border-t border-border-subtle">
                    <span className="text-2xs text-fg-muted">
                      Created {formatShowCreatedAt(stats.createdAt)}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <IconButton
                        label="Delete show"
                        variant="danger"
                        size="sm"
                        onClick={(e) => handleDelete(e, show)}
                      >
                        <FaTrashAlt />
                      </IconButton>
                      <Button
                        size="sm"
                        variant="primary"
                        leading={<FiPlay />}
                        onClick={() => handleStage(show)}
                      >
                        Stage
                      </Button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );
}

// Compact 4-up of the headline figures for a show. Sized to fit two rows
// inside a picker card without crowding the title or actions.
function ShowStatGrid({ stats }) {
  const cells = [
    { label: "Cues", value: stats.cues },
    { label: "Shells", value: stats.shells },
    { label: "Racks", value: stats.racks },
    { label: "Other items", value: stats.nonShellItems },
  ];
  return (
    <div className="grid grid-cols-4 gap-2">
      {cells.map((c) => (
        <div
          key={c.label}
          className="rounded-sm bg-surface-1 border border-border-subtle px-2 py-1.5 min-w-0"
        >
          <div className="text-2xs text-fg-muted truncate">{c.label}</div>
          <div className="num text-sm text-fg-primary leading-none mt-0.5 tabular-nums">
            {c.value}
          </div>
        </div>
      ))}
    </div>
  );
}
