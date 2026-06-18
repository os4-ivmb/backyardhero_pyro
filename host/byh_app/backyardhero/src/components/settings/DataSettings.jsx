import { useRef, useState } from "react";
import {
  MdCheckCircle,
  MdDownload,
  MdUploadFile,
  MdWarning,
} from "react-icons/md";

import { Button, Card, Modal } from "@/design";
import { apiUrl } from "@/util/clientEnv";

export default function DataSettings() {
  const fileInputRef = useRef(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  const handleChooseFile = (event) => {
    const file = event.target.files?.[0] || null;
    setError(null);
    setMessage(null);
    setSelectedFile(file);
    if (file) setConfirmOpen(true);
  };

  const resetPicker = () => {
    if (fileInputRef.current) fileInputRef.current.value = "";
    setSelectedFile(null);
  };

  const handleImport = async () => {
    if (!selectedFile) return;
    setImporting(true);
    setError(null);
    setMessage(null);
    try {
      const body = new FormData();
      body.append("database", selectedFile);
      const response = await fetch(apiUrl("/api/system/data"), {
        method: "POST",
        body,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Import failed.");
      }
      setMessage(payload.message || "Database imported. Backyard Hero is restarting.");
      setConfirmOpen(false);
      resetPicker();
      setTimeout(() => window.location.reload(), 5000);
    } catch (err) {
      setError(err.message || "Import failed.");
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-fg-muted leading-snug">
        Export your Backyard Hero data as a SQLite database file, then import
        that file on another device. Importing replaces the current device&apos;s
        data and restarts the app so it opens the new database cleanly.
      </p>

      {message ? (
        <div className="flex items-start gap-2 px-3 py-2 bg-ok-bg/60 border border-ok/40 text-ok-fg text-sm rounded-sm">
          <MdCheckCircle className="mt-0.5 shrink-0" />
          <span>{message}</span>
        </div>
      ) : null}

      {error ? (
        <div className="flex items-start gap-2 px-3 py-2 bg-danger-bg/60 border border-danger/50 text-danger-fg text-sm rounded-sm">
          <MdWarning className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Card padding="md" tone="inset" className="flex flex-col gap-3">
          <div>
            <div className="eyebrow mb-1">Export</div>
            <div className="text-sm text-fg-secondary">
              Download a snapshot of the current database.
            </div>
          </div>
          <Button
            as="a"
            href={apiUrl("/api/system/data")}
            variant="primary"
            leading={<MdDownload />}
            className="self-start"
          >
            Download database
          </Button>
        </Card>

        <Card padding="md" tone="inset" className="flex flex-col gap-3">
          <div>
            <div className="eyebrow mb-1">Import</div>
            <div className="text-sm text-fg-secondary">
              Replace this device&apos;s database with an exported file.
            </div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".db,.sqlite,.sqlite3,application/vnd.sqlite3,application/x-sqlite3"
            className="hidden"
            onChange={handleChooseFile}
          />
          <Button
            variant="outline"
            leading={<MdUploadFile />}
            onClick={() => fileInputRef.current?.click()}
            className="self-start"
          >
            Choose database
          </Button>
        </Card>
      </div>

      <Modal
        isOpen={confirmOpen}
        onClose={() => {
          if (!importing) {
            setConfirmOpen(false);
            resetPicker();
          }
        }}
        title="Import Database"
        eyebrow="Replace current data"
        size="lg"
        dismissOnBackdrop={!importing}
        dismissOnEscape={!importing}
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => {
                setConfirmOpen(false);
                resetPicker();
              }}
              disabled={importing}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              leading={<MdUploadFile />}
              onClick={handleImport}
              loading={importing}
            >
              Import and restart
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex items-start gap-2 px-3 py-2 bg-warn-bg/60 border border-warn/40 text-warn-fg rounded-sm">
            <MdWarning className="mt-0.5 shrink-0" />
            <span>
              This will replace all shows, inventory, racks, and receiver data
              on this device. The current database will be backed up first.
            </span>
          </div>
          <div className="text-fg-secondary">
            Selected file:{" "}
            <span className="font-medium text-fg-primary">
              {selectedFile?.name || "No file selected"}
            </span>
          </div>
        </div>
      </Modal>
    </div>
  );
}
