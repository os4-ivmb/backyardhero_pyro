import React, { useEffect, useMemo, useState } from "react";
import axios from "axios";
import {
  Button,
  Field,
  Modal,
  inputClass,
  selectClass,
  fieldHintClass,
} from "@/design";
import { FaCheck } from "react-icons/fa6";
import {
  FiAlertCircle,
  FiAlertTriangle,
  FiEye,
  FiEyeOff,
  FiWifi,
} from "react-icons/fi";
import SaveBar from "./SaveBar";

// Settings card for the on-board WiFi access point hosted by the Pi.
// Lets the operator rename the network and change the WPA2 passphrase
// from the UI without ssh'ing into the host.
//
// The actual change is applied by /usr/local/sbin/byh-ap-apply.py on
// the host, which the docker container can't reach directly. We round-
// trip through /data/byh_ap_request.json (a file the container shares
// with the host via the docker volume) and wait for the matching
// status entry to land in /data/byh_ap_status.json. See the API route
// at /api/system/ap for the full contract.
//
// Applying a change kicks every client off the AP (including the
// operator's phone). We surface that loudly via a confirmation modal
// that doubles as a "here's what to reconnect to" cheat-sheet -- the
// browser tab itself almost certainly won't survive the radio reset,
// so the operator needs the new credentials in front of them BEFORE
// they hit "Apply now".

const CHANNELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

function normalize(current) {
  if (!current) {
    return { ssid: "", password: "", channel: 6, country: "US" };
  }
  return {
    ssid: current.ssid || "",
    password: current.password || "",
    channel: Number.isFinite(Number(current.channel))
      ? Number(current.channel)
      : 6,
    country: (current.country || "US").toUpperCase(),
  };
}

function validate(draft) {
  if (!draft.ssid || draft.ssid.length < 1 || draft.ssid.length > 32) {
    return "SSID must be 1-32 characters.";
  }
  if (!/^[\x20-\x7e]+$/.test(draft.ssid)) {
    return "SSID must contain only printable ASCII characters.";
  }
  if (!draft.password || draft.password.length < 8 || draft.password.length > 63) {
    return "Password must be 8-63 characters (WPA2).";
  }
  if (!/^[\x20-\x7e]+$/.test(draft.password)) {
    return "Password must contain only printable ASCII characters.";
  }
  if (!/^[A-Z]{2}$/.test(draft.country)) {
    return "Country must be a 2-letter ISO code (e.g. US, GB, DE).";
  }
  if (!Number.isInteger(draft.channel) || draft.channel < 1 || draft.channel > 14) {
    return "Channel must be 1-14.";
  }
  return null;
}

export default function AccessPointSettings() {
  const [current, setCurrent] = useState(null);
  const [lastStatus, setLastStatus] = useState(null);
  const [draft, setDraft] = useState(normalize(null));
  const [baseline, setBaseline] = useState(JSON.stringify(normalize(null)));
  const [loadError, setLoadError] = useState(null);
  const [showPw, setShowPw] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState(null);
  const [appliedAt, setAppliedAt] = useState(null);
  const [appliedResult, setAppliedResult] = useState(null);

  const fetchState = async () => {
    try {
      const { data } = await axios.get("/api/system/ap");
      setCurrent(data?.current || null);
      setLastStatus(data?.last_status || null);
      const norm = normalize(data?.current);
      setDraft(norm);
      setBaseline(JSON.stringify(norm));
      setLoadError(null);
    } catch (e) {
      const msg =
        e?.response?.data?.error || e?.message || "Failed to load AP state";
      setLoadError(msg);
    }
  };

  useEffect(() => {
    fetchState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== baseline,
    [draft, baseline]
  );

  const inlineError = useMemo(
    () => (dirty ? validate(draft) : null),
    [draft, dirty]
  );

  const onAttemptSave = () => {
    setApplyError(null);
    const err = validate(draft);
    if (err) {
      setApplyError(err);
      return;
    }
    setConfirmOpen(true);
  };

  const onReset = () => {
    setDraft(normalize(current));
    setApplyError(null);
  };

  const onConfirmApply = async () => {
    setApplying(true);
    setApplyError(null);
    try {
      const { data } = await axios.post("/api/system/ap", draft, {
        // Match the server's poll budget (10s) + buffer; if hostapd
        // restarts before the response lands we still want the request
        // to time out cleanly rather than hang the spinner forever.
        timeout: 20_000,
      });
      setAppliedResult(data);
      setAppliedAt(Date.now());
      setBaseline(JSON.stringify(draft));
      // Don't auto-close the modal: the operator needs to read the
      // reconnect instructions, and we don't know when their browser
      // will actually be talking to us again.
    } catch (e) {
      const msg =
        e?.response?.data?.error ||
        e?.message ||
        "Apply failed -- the request reached the host but couldn't be confirmed.";
      setApplyError(msg);
    } finally {
      setApplying(false);
    }
  };

  const onCloseConfirm = () => {
    if (applying) return;
    setConfirmOpen(false);
    setAppliedResult(null);
    setApplyError(null);
    // Re-pull state in case the apply already updated current.
    fetchState();
  };

  const lastRolledBack =
    lastStatus && lastStatus.ok === false && lastStatus.phase === "rolled_back";

  if (loadError) {
    return (
      <div className="flex flex-col gap-3">
        <div className="text-sm text-danger-fg inline-flex items-start gap-2">
          <FiAlertCircle className="mt-0.5 shrink-0" />
          <div>
            {loadError}
            <div className={fieldHintClass + " mt-1"}>
              The host-side apply service may not be installed. Run{" "}
              <code className="px-1 rounded bg-surface-inset">
                sudo host/run/pi/install.sh
              </code>{" "}
              on the Pi to set it up.
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!current) {
    return <div className="text-sm text-fg-muted">Loading AP state…</div>;
  }

  if (!current.configured) {
    return (
      <div className="text-sm text-fg-muted flex items-start gap-2">
        <FiAlertCircle className="mt-0.5 shrink-0 text-warn-fg" />
        <div>
          No access point is configured on this host. If this is a Pi
          install, run <code>sudo host/run/pi/install.sh</code> with WiFi
          configuration enabled.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="text-xs text-fg-muted">
        These credentials configure the WiFi network the Pi broadcasts.
        Connect any client device (phone, laptop) to this network and
        the web UI is reachable at{" "}
        <code className="px-1 rounded bg-surface-inset">
          {current.web_url || "http://backyardhero.local/"}
        </code>
        {" "}(or{" "}
        <code className="px-1 rounded bg-surface-inset">
          http://{current.gateway_ip || "192.168.42.1"}/
        </code>
        ). Changing these values resets the radio — every connected
        device is kicked off and must reconnect with the new
        credentials.
      </div>

      {lastRolledBack ? (
        <div className="rounded-sm border border-warn-fg/30 bg-warn-fg/10 text-warn-fg text-xs px-3 py-2 inline-flex gap-2 items-start">
          <FiAlertTriangle className="mt-0.5 shrink-0" />
          <div>
            The previous apply rolled back:{" "}
            <span className="text-fg-secondary">
              {lastStatus.error || "hostapd refused the new config"}
            </span>
            . The values below reflect the working configuration that
            was restored.
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr] gap-3">
        <Field
          label="Network name (SSID)"
          htmlFor="ap-ssid"
          hint="1–32 characters. Visible in WiFi network lists on every client."
        >
          <input
            id="ap-ssid"
            type="text"
            value={draft.ssid}
            onChange={(e) => setDraft((d) => ({ ...d, ssid: e.target.value }))}
            className={inputClass + " font-mono"}
            maxLength={32}
            spellCheck={false}
            autoComplete="off"
          />
        </Field>

        <Field
          label="Country"
          htmlFor="ap-country"
          hint="Sets the regulatory domain. Affects which channels are legal."
        >
          <input
            id="ap-country"
            type="text"
            value={draft.country}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                country: e.target.value.toUpperCase().slice(0, 2),
              }))
            }
            className={inputClass + " font-mono uppercase"}
            maxLength={2}
            spellCheck={false}
            autoComplete="off"
          />
        </Field>
      </div>

      <Field
        label="Password (WPA2)"
        htmlFor="ap-password"
        hint="8–63 printable characters. Stored in cleartext on the host (single-tenant LAN)."
      >
        <div className="relative">
          <input
            id="ap-password"
            type={showPw ? "text" : "password"}
            value={draft.password}
            onChange={(e) =>
              setDraft((d) => ({ ...d, password: e.target.value }))
            }
            className={inputClass + " font-mono pr-10"}
            maxLength={63}
            spellCheck={false}
            autoComplete="new-password"
          />
          <button
            type="button"
            onClick={() => setShowPw((v) => !v)}
            className="absolute inset-y-0 right-2 inline-flex items-center text-fg-muted hover:text-fg-secondary"
            aria-label={showPw ? "Hide password" : "Show password"}
            title={showPw ? "Hide password" : "Show password"}
          >
            {showPw ? <FiEyeOff /> : <FiEye />}
          </button>
        </div>
      </Field>

      <Field
        label="Channel"
        htmlFor="ap-channel"
        hint="2.4 GHz. Pick whatever's quietest in your area; 1, 6, and 11 don't overlap each other."
      >
        <div className="relative max-w-[10rem]">
          <select
            id="ap-channel"
            value={draft.channel}
            onChange={(e) =>
              setDraft((d) => ({ ...d, channel: parseInt(e.target.value, 10) }))
            }
            className={selectClass}
          >
            {CHANNELS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </Field>

      <SaveBar
        dirty={dirty}
        saving={applying}
        error={inlineError || applyError}
        savedAt={appliedAt}
        onSave={onAttemptSave}
        onReset={onReset}
        saveLabel="Apply…"
      />

      <ConfirmApplyModal
        isOpen={confirmOpen}
        applying={applying}
        appliedResult={appliedResult}
        applyError={applyError}
        draft={draft}
        webUrl={current.web_url}
        onClose={onCloseConfirm}
        onConfirm={onConfirmApply}
      />
    </div>
  );
}

function ConfirmApplyModal({
  isOpen,
  applying,
  appliedResult,
  applyError,
  draft,
  webUrl,
  onClose,
  onConfirm,
}) {
  const applied = !!appliedResult?.ok;
  const reconnectUrl = webUrl || "http://backyardhero.local/";

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={applied ? "AP change scheduled" : "Confirm AP change"}
      eyebrow={<FiWifi className="inline mr-1" />}
      size="md"
      footer={
        applied ? (
          <Button variant="primary" size="sm" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              disabled={applying}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={onConfirm}
              loading={applying}
              disabled={applying}
            >
              Apply now
            </Button>
          </>
        )
      }
    >
      {applied ? (
        <div className="flex flex-col gap-3 text-sm">
          <div className="inline-flex items-center gap-2 text-ok-fg">
            <FaCheck /> Saved. The radio will reset in a few seconds.
          </div>
          <div className="text-fg-secondary">
            Your device will be disconnected from the current WiFi
            network. Reconnect using the new credentials, then reopen
            the UI.
          </div>
          <ReconnectCard
            ssid={draft.ssid}
            password={draft.password}
            url={reconnectUrl}
          />
          <div className={fieldHintClass}>
            If you can't see the new network within ~10 seconds, the
            apply may have rolled back. Reconnect to the old network
            and reload Settings → Network to see the live state.
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <div className="inline-flex items-start gap-2 text-warn-fg">
            <FiAlertTriangle className="mt-0.5 shrink-0" />
            <div>
              Applying will reset the WiFi radio. <strong>Every device
              currently connected to this Pi's network will be kicked
              off</strong>, including this one — you'll need to reconnect
              using the new credentials below.
            </div>
          </div>
          <ReconnectCard
            ssid={draft.ssid}
            password={draft.password}
            url={reconnectUrl}
          />
          <div className={fieldHintClass}>
            If the new credentials don't work, the host's apply script
            automatically rolls back to the previous working
            configuration after a few seconds.
          </div>
          {applyError ? (
            <div className="text-danger-fg inline-flex items-start gap-2 text-xs">
              <FiAlertCircle className="mt-0.5 shrink-0" /> {applyError}
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

function ReconnectCard({ ssid, password, url }) {
  return (
    <div className="rounded-sm border border-border bg-surface-inset px-3 py-2 text-sm">
      <ReconnectRow label="SSID" value={ssid} mono />
      <ReconnectRow label="Password" value={password} mono />
      <ReconnectRow label="URL" value={url} mono />
    </div>
  );
}

function ReconnectRow({ label, value, mono }) {
  return (
    <div className="flex items-center gap-3 py-1">
      <div className="text-2xs uppercase tracking-wider text-fg-muted w-20 shrink-0">
        {label}
      </div>
      <div
        className={
          "flex-1 truncate text-fg-primary " + (mono ? "font-mono" : "")
        }
      >
        {value}
      </div>
    </div>
  );
}
