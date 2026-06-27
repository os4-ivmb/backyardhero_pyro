import React, { useState } from "react";
import { FiUploadCloud } from "react-icons/fi";
import { Field, selectClass, cn } from "@/design";

// Step 1: pick a source (tiles), then the source-specific panel (import
// type select + file upload scoped to that source+type).
export default function Step1SelectSource({
  sources,
  sourceId,
  onSelectSource,
  source,
  typeId,
  onSelectType,
  type,
  file,
  onSelectFile,
  processing,
  processError,
}) {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="eyebrow mb-2">Import from</div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {sources.map((s) => (
            <SourceTile
              key={s.id}
              source={s}
              selected={s.id === sourceId}
              disabled={processing}
              onClick={() => onSelectSource(s.id)}
            />
          ))}
        </div>
      </div>

      {source ? (
        <div className="flex flex-col gap-4 rounded-md border border-border-subtle bg-surface-base/40 p-4">
          <div className="text-sm font-semibold text-fg-primary">
            {source.name} import
          </div>

          <Field label="Import type">
            <select
              value={typeId || ""}
              onChange={(e) => onSelectType(e.target.value)}
              className={selectClass}
              disabled={processing}
            >
              {source.types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="File">
            <FileDrop
              file={file}
              accept={type?.accept}
              disabled={processing}
              onSelectFile={onSelectFile}
            />
          </Field>
        </div>
      ) : null}

      {processError ? (
        <div className="rounded-sm border border-danger/40 bg-danger-bg/60 px-3 py-2 text-xs text-danger-fg">
          {processError}
        </div>
      ) : null}
    </div>
  );
}

function SourceTile({ source, selected, disabled, onClick }) {
  const [logoFailed, setLogoFailed] = useState(false);
  const hasLogo = source.logo && !logoFailed;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={source.name}
      className={cn(
        "flex items-center justify-center h-32 rounded-lg border-2 transition-all overflow-hidden",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        // A white-ish tile lets logos with a white background blend in.
        hasLogo ? "bg-white p-5" : "bg-surface-1 px-3",
        selected
          ? "border-accent ring-2 ring-accent/30"
          : "border-border hover:border-border-strong",
      )}
      aria-pressed={selected}
    >
      {hasLogo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={source.logo}
          alt={source.name}
          className="max-h-full max-w-full object-contain"
          onError={() => setLogoFailed(true)}
        />
      ) : (
        <span className="text-base font-semibold text-fg-primary">
          {source.name}
        </span>
      )}
    </button>
  );
}

function FileDrop({ file, accept, disabled, onSelectFile }) {
  return (
    <label
      className={cn(
        "flex items-center gap-3 rounded-sm border border-dashed border-border px-3 py-3 cursor-pointer transition-colors",
        "hover:border-border-strong",
        disabled && "opacity-50 cursor-not-allowed",
      )}
    >
      <FiUploadCloud className="w-5 h-5 text-fg-muted shrink-0" />
      <span className="min-w-0 truncate text-sm text-fg-secondary">
        {file ? file.name : "Choose a file to upload…"}
      </span>
      <input
        type="file"
        accept={accept}
        disabled={disabled}
        className="hidden"
        onChange={(e) => onSelectFile(e.target.files?.[0] || null)}
      />
    </label>
  );
}
