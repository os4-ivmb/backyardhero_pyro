import React, { useEffect, useRef } from "react";
import { MdClose } from "react-icons/md";

import { IconButton } from "./IconButton";
import { cn } from "./cn";

// Single source of truth for modal/dialog chrome. Replaces the bespoke
// `fixed inset-0 ... bg-gray-800` panels that were sprinkled across the
// show builder. Wires up ESC-to-close, click-outside-to-close, body
// scroll lock, focus restore and the standard header bar.
//
// Usage:
//   <Modal isOpen={open} onClose={...} title="Add item" size="md"
//     footer={<><Button>Cancel</Button><Button variant="primary">Save</Button></>}
//   >
//     ...body...
//   </Modal>

const SIZES = {
  // Width caps; the dialog grows up to these on viewport.
  xs: "max-w-xs",
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-2xl",
  "2xl": "max-w-3xl",
  "3xl": "max-w-5xl",
};

export function Modal({
  isOpen,
  onClose,
  title,
  eyebrow,
  size = "md",
  children,
  footer,
  // Optional left-aligned footer slot for destructive actions, etc.
  footerStart,
  // Stack depth: 0 = base modal, 1 = nested-on-top. Used to bump z-index
  // and lift the panel surface so layered dialogs read as such.
  layer = 0,
  className,
  bodyClassName,
  dismissOnBackdrop = true,
  dismissOnEscape = true,
  hideHeader = false,
  ariaLabel,
}) {
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (!isOpen) {
      wasOpenRef.current = false;
      return undefined;
    }
    wasOpenRef.current = true;

    const onKey = (e) => {
      if (dismissOnEscape && e.key === "Escape") {
        e.stopPropagation();
        onClose?.();
      }
    };
    window.addEventListener("keydown", onKey);

    // Lock body scroll while a modal is open. Multiple stacked modals each
    // set this to "hidden", which is a no-op once already hidden.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [isOpen, dismissOnEscape, onClose]);

  if (!isOpen) return null;

  const baseZ = 100 + layer * 10;
  const panelSurface = layer > 0 ? "bg-surface-2" : "bg-surface-1";

  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4 sm:p-6"
      style={{ zIndex: baseZ }}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel || title}
    >
      <div
        className="absolute inset-0 bg-surface-base/70 backdrop-blur-sm"
        onClick={dismissOnBackdrop ? onClose : undefined}
        role="presentation"
      />
      <div
        className={cn(
          "relative w-full max-h-[min(92dvh,840px)] flex flex-col overflow-hidden",
          "rounded-md border border-border shadow-e3",
          panelSurface,
          SIZES[size],
          className
        )}
        style={{ zIndex: baseZ + 1 }}
        onClick={(e) => e.stopPropagation()}
      >
        {!hideHeader && (title || onClose) ? (
          <div className="flex items-center justify-between gap-3 px-5 h-12 border-b border-border-subtle shrink-0">
            <div className="min-w-0">
              {eyebrow ? <div className="eyebrow mb-0.5">{eyebrow}</div> : null}
              {title ? (
                <h3 className="text-base font-semibold text-fg-primary truncate leading-tight">
                  {title}
                </h3>
              ) : null}
            </div>
            {onClose ? (
              <IconButton label="Close" size="sm" onClick={onClose}>
                <MdClose className="w-5 h-5" />
              </IconButton>
            ) : null}
          </div>
        ) : null}

        <div
          className={cn(
            "flex-1 overflow-y-auto overscroll-contain px-5 py-4",
            bodyClassName
          )}
        >
          {children}
        </div>

        {footer || footerStart ? (
          <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border-subtle bg-surface-1/40 shrink-0">
            <div className="flex items-center gap-2 min-w-0">{footerStart}</div>
            <div className="flex items-center gap-2 shrink-0">{footer}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default Modal;
