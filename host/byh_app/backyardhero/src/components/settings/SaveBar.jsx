import React, { useEffect, useState } from "react";
import { Button, cn } from "@/design";
import { FaCheck } from "react-icons/fa6";
import { FiAlertCircle } from "react-icons/fi";

// Footer strip for a settings card. Shows status on the left, save +
// reset on the right. All the wiring (dirty / saving / error / savedAt)
// is owned by useDraft so this component is just chrome.

export default function SaveBar({
  dirty,
  saving,
  error,
  savedAt,
  onSave,
  onReset,
  saveLabel = "Save",
  className,
}) {
  // Show "Saved" for a brief window after a successful save so the
  // operator gets confirmation without it sitting there forever.
  const [showSaved, setShowSaved] = useState(false);
  useEffect(() => {
    if (!savedAt) return;
    setShowSaved(true);
    const t = setTimeout(() => setShowSaved(false), 2500);
    return () => clearTimeout(t);
  }, [savedAt]);

  return (
    <div
      className={cn(
        "flex items-center gap-3 pt-3 mt-3 border-t border-border-subtle",
        className
      )}
    >
      <div className="text-xs flex items-center gap-2 min-w-0 flex-1">
        {error ? (
          <span className="text-danger-fg inline-flex items-center gap-1.5 truncate">
            <FiAlertCircle aria-hidden /> {error}
          </span>
        ) : saving ? (
          <span className="text-fg-muted">Saving…</span>
        ) : showSaved ? (
          <span className="text-ok-fg inline-flex items-center gap-1.5">
            <FaCheck aria-hidden /> Saved
          </span>
        ) : dirty ? (
          <span className="text-warn-fg">Unsaved changes</span>
        ) : (
          <span className="text-fg-muted">Up to date</span>
        )}
      </div>
      {onReset && dirty ? (
        <Button size="sm" variant="ghost" onClick={onReset} disabled={saving}>
          Reset
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="primary"
        onClick={onSave}
        disabled={!dirty || saving}
        loading={saving}
      >
        {saveLabel}
      </Button>
    </div>
  );
}
