import { useCallback, useEffect, useState } from "react";
import {
  MdCheckCircle,
  MdCloudUpload,
  MdCloudOff,
  MdLogout,
  MdWarning,
} from "react-icons/md";

import { Button, Card } from "@/design";
import { apiUrl } from "@/util/clientEnv";

// Cloud Sync (Cloud Builder plan §6). On-device panel that signs the operator
// into their cloud account and pushes local data up to the cloud editor.
// Phase 2A pushes inventory, firing profiles, and receivers. Shows + audio
// follow in Phase 2B.

const COUNT_ENTITIES = [
  ["inventory", "Inventory"],
  ["firingProfiles", "Firing profiles"],
  ["receivers", "Receivers"],
  ["shows", "Shows"],
  ["racks", "Racks"],
];

function EntityResult({ label, stats }) {
  if (!stats) return null;
  const parts = [];
  if (stats.inserted) parts.push(`${stats.inserted} added`);
  if (stats.updated) parts.push(`${stats.updated} updated`);
  if (stats.skipped) parts.push(`${stats.skipped} unchanged`);
  const summary = parts.length ? parts.join(", ") : "no changes";
  const errors = stats.errors || [];
  const hasErrors = errors.length > 0;
  // Distinct error messages so 94 rows failing the same way show one line.
  const uniqueMessages = [...new Set(errors.map((e) => e.error))].slice(0, 5);
  return (
    <div className="flex flex-col gap-1 py-1">
      <div className="flex items-start justify-between gap-3 text-sm">
        <span className="text-fg-secondary">{label}</span>
        <span className={hasErrors ? "text-danger-fg" : "text-fg-primary"}>
          {summary}
          {hasErrors ? ` · ${errors.length} failed` : ""}
        </span>
      </div>
      {hasErrors ? (
        <ul className="text-xs text-danger-fg/90 list-disc pl-5">
          {uniqueMessages.map((m, i) => (
            <li key={i} className="break-words">{m}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default function CloudSyncPanel() {
  const [status, setStatus] = useState(null); // { configured, connected, email }
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [report, setReport] = useState(null);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/api/sync/status"));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to load status.");
      setStatus(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const handleSignIn = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(apiUrl("/api/sync/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Sign-in failed.");
      setPassword("");
      setMessage(`Connected as ${data.email}.`);
      await refreshStatus();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleSignOut = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(apiUrl("/api/sync/logout"), { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Sign-out failed.");
      }
      setReport(null);
      await refreshStatus();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handlePush = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    setReport(null);
    try {
      const res = await fetch(apiUrl("/api/sync/push"), { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Push failed.");
      setReport(data.report);
      setMessage(
        data.ok
          ? "Push complete."
          : "Push finished with some errors — see details below.",
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="text-sm text-fg-muted">Loading…</div>;
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-fg-muted leading-snug">
        Push this device&apos;s inventory, firing profiles, receivers, shows, and
        racks (including show audio) up to your cloud editor. Pushing is one-way
        (device → cloud) and safe to repeat — items already pushed are updated in
        place rather than duplicated.
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

      {status && !status.configured ? (
        <div className="flex items-start gap-2 px-3 py-2 bg-warn-bg/60 border border-warn/40 text-warn-fg text-sm rounded-sm">
          <MdCloudOff className="mt-0.5 shrink-0" />
          <span>
            Cloud sync isn&apos;t configured on this device. Set
            {" "}<code>CLOUD_SYNC_SUPABASE_URL</code> and{" "}
            <code>CLOUD_SYNC_SUPABASE_ANON_KEY</code> in the environment, then
            restart.
          </span>
        </div>
      ) : null}

      {status?.connected ? (
        <Card padding="md" tone="inset" className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="eyebrow mb-1">Connected</div>
              <div className="text-sm text-fg-primary font-medium">
                {status.email}
              </div>
            </div>
            <Button
              variant="outline"
              leading={<MdLogout />}
              onClick={handleSignOut}
              disabled={busy}
            >
              Disconnect
            </Button>
          </div>

          <Button
            variant="primary"
            leading={<MdCloudUpload />}
            onClick={handlePush}
            loading={busy}
            className="self-start"
          >
            Push to cloud
          </Button>

          {report ? (
            <div className="border-t border-border-subtle pt-2">
              {COUNT_ENTITIES.map(([key, label]) => (
                <EntityResult key={key} label={label} stats={report[key]} />
              ))}
              {report.warnings && report.warnings.length > 0 ? (
                <ul className="mt-2 text-xs text-warn-fg list-disc pl-5">
                  {report.warnings.slice(0, 8).map((w, i) => (
                    <li key={i} className="break-words">{w}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </Card>
      ) : status?.configured ? (
        <Card padding="md" tone="inset">
          <form onSubmit={handleSignIn} className="flex flex-col gap-3">
            <div className="eyebrow">Sign in to your cloud account</div>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-fg-secondary">Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
                className="px-3 h-10 bg-bg-base border border-border-subtle rounded-sm text-fg-primary"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-fg-secondary">Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                className="px-3 h-10 bg-bg-base border border-border-subtle rounded-sm text-fg-primary"
              />
            </label>
            <Button
              type="submit"
              variant="primary"
              loading={busy}
              className="self-start"
            >
              Connect
            </Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
