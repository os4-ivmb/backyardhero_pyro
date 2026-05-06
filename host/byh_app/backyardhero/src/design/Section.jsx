import React from "react";
import { cn } from "./cn";

// Page-level section header. Keeps spacing consistent between the
// inventory, settings and builder pages.
export function Section({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}) {
  return (
    <section className={cn("flex flex-col gap-3", className)}>
      {(title || actions || description) && (
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            {title ? (
              <h2 className="text-xl font-semibold text-fg-primary tracking-tight">
                {title}
              </h2>
            ) : null}
            {description ? (
              <p className="text-sm text-fg-muted mt-0.5 max-w-prose">
                {description}
              </p>
            ) : null}
          </div>
          {actions ? (
            <div className="flex items-center gap-2 shrink-0">{actions}</div>
          ) : null}
        </header>
      )}
      <div className={cn(bodyClassName)}>{children}</div>
    </section>
  );
}

export default Section;
