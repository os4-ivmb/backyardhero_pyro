import React, { useState } from "react";
import axios from "axios";
import { MdCheckCircle, MdOutlineBugReport } from "react-icons/md";

import { Modal, Button, Field, inputClass, selectClass } from "@/design";
import { apiUrl } from "@/util/clientEnv";
import useAppStore from "@/store/useAppStore";

// In-app support ticket. Collects the same fields as the cloud bug form
// (severity / description / expected / actual), then the server route attaches
// a full diagnostics snapshot (versions, receivers, daemon + state files,
// staged show data, log tails) and forwards it to the cloud gateway. On success
// we surface the assigned report id (e.g. BHAR-42).

const SEVERITIES = [
  { value: "low", label: "Low — minor annoyance" },
  { value: "medium", label: "Medium — affects my workflow" },
  { value: "high", label: "High — can't run my show" },
  { value: "critical", label: "Critical — safety / total failure" },
];

const EMPTY = {
  title: "",
  severity: "medium",
  description: "",
  steps_to_reproduce: "",
  expected_behavior: "",
  actual_behavior: "",
  contact_email: "",
};

export default function SupportTicketModal({ isOpen, onClose }) {
  const stagedShowId = useAppStore((s) => s.stagedShowId);
  const [form, setForm] = useState(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const close = () => {
    if (submitting) return;
    onClose?.();
    // Reset after the modal has closed so the form doesn't flicker on the way out.
    setTimeout(() => {
      setForm(EMPTY);
      setError(null);
      setResult(null);
    }, 200);
  };

  const submit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await axios.post(apiUrl("/api/support/bug_report"), {
        ...form,
        staged_show_id: stagedShowId ?? null,
      });
      setResult(res.data);
    } catch (err) {
      const message =
        err?.response?.data?.error ||
        err?.message ||
        "Something went wrong submitting your report.";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      size="xl"
      eyebrow="Support"
      title="Report a problem"
      footer={
        result ? (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close} disabled={submitting}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              form="support-ticket-form"
              loading={submitting}
              leading={<MdOutlineBugReport />}
            >
              {submitting ? "Submitting…" : "Submit report"}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <MdCheckCircle className="h-12 w-12 text-live-fg" />
          <h3 className="text-lg font-semibold text-fg-primary">Report submitted</h3>
          {result.readable_id ? (
            <p className="text-sm text-fg-secondary">
              Your report ID is{" "}
              <span className="font-mono font-semibold text-fg-primary">
                {result.readable_id}
              </span>
              . Hang on to it — the team can look it up directly.
            </p>
          ) : (
            <p className="text-sm text-fg-secondary">
              Thanks! Your report and diagnostics were sent to the team.
            </p>
          )}
        </div>
      ) : (
        <form id="support-ticket-form" onSubmit={submit} className="space-y-4">
          <p className="rounded-sm border border-border bg-surface-inset px-3 py-2 text-xs text-fg-secondary">
            Submitting attaches a diagnostics snapshot — app + dongle versions,
            receiver states, daemon/state files, your staged show, and recent log
            lines — so the team can debug without a back-and-forth.
          </p>

          <Field label="Title" htmlFor="st-title">
            <input
              id="st-title"
              className={inputClass}
              placeholder="Short summary of the problem"
              value={form.title}
              onChange={set("title")}
              maxLength={200}
              required
            />
          </Field>

          <Field label="How bad is it?" htmlFor="st-severity">
            <select
              id="st-severity"
              className={selectClass}
              value={form.severity}
              onChange={set("severity")}
            >
              {SEVERITIES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="What happened?" htmlFor="st-description">
            <textarea
              id="st-description"
              className={inputClass + " h-24 py-2 leading-snug"}
              placeholder="Describe the problem"
              value={form.description}
              onChange={set("description")}
              required
            />
          </Field>

          <Field label="How does it happen again?" htmlFor="st-steps" hint="Optional">
            <textarea
              id="st-steps"
              className={inputClass + " h-20 py-2 leading-snug"}
              placeholder="Steps to reproduce"
              value={form.steps_to_reproduce}
              onChange={set("steps_to_reproduce")}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="What should have happened?" htmlFor="st-expected" hint="Optional">
              <textarea
                id="st-expected"
                className={inputClass + " h-20 py-2 leading-snug"}
                placeholder="Expected result"
                value={form.expected_behavior}
                onChange={set("expected_behavior")}
              />
            </Field>
            <Field label="What actually happened?" htmlFor="st-actual" hint="Optional">
              <textarea
                id="st-actual"
                className={inputClass + " h-20 py-2 leading-snug"}
                placeholder="Actual result"
                value={form.actual_behavior}
                onChange={set("actual_behavior")}
              />
            </Field>
          </div>

          <Field
            label="Contact email"
            htmlFor="st-email"
            hint="Optional — so the team can follow up with you."
          >
            <input
              id="st-email"
              type="email"
              className={inputClass}
              placeholder="you@example.com"
              value={form.contact_email}
              onChange={set("contact_email")}
            />
          </Field>

          {error ? (
            <p className="rounded-sm border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger-fg">
              {error}
            </p>
          ) : null}
        </form>
      )}
    </Modal>
  );
}
