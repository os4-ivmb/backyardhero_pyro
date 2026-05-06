import React from "react";
import { cn } from "./cn";

// Calm-table primitive. Replaces the dense, heavy-bordered inventory
// table. Tone:
//   - no row borders, just a hairline header rule and very faint zebra
//   - sticky header, tabular numerics
//   - rows are clickable -- secondary actions hide behind a meatball or
//     reveal on hover

export function Table({ className, children }) {
  return (
    <div
      className={cn(
        "w-full overflow-x-auto rounded-md bg-surface-1 border border-border-subtle",
        className
      )}
    >
      <table className="min-w-full text-sm">
        {children}
      </table>
    </div>
  );
}

export function THead({ children }) {
  return (
    <thead className="text-fg-muted">
      <tr className="border-b border-border-subtle">{children}</tr>
    </thead>
  );
}

export function TH({
  children,
  align = "left",
  sortable = false,
  active = false,
  direction = "asc",
  onClick,
  className,
  numeric = false,
  ...rest
}) {
  return (
    <th
      onClick={sortable ? onClick : undefined}
      scope="col"
      className={cn(
        "h-9 px-3 text-2xs uppercase tracking-wider font-semibold whitespace-nowrap",
        align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left",
        sortable && "cursor-pointer select-none hover:text-fg-primary",
        active && "text-fg-primary",
        numeric && "num",
        className
      )}
      {...rest}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {sortable && active ? (
          <span className="text-fg-muted">{direction === "asc" ? "▲" : "▼"}</span>
        ) : null}
      </span>
    </th>
  );
}

export function TBody({ children }) {
  return <tbody>{children}</tbody>;
}

export function TR({
  children,
  onClick,
  selected = false,
  attention = false,
  className,
  ...rest
}) {
  const interactive = !!onClick;
  return (
    <tr
      onClick={onClick}
      className={cn(
        "border-b border-border-subtle/60 last:border-0 transition-colors",
        interactive && "cursor-pointer hover:bg-surface-2/60",
        selected && "bg-accent-muted/30",
        attention && "bg-warn-bg/30",
        className
      )}
      {...rest}
    >
      {children}
    </tr>
  );
}

export function TD({
  children,
  align = "left",
  numeric = false,
  className,
  ...rest
}) {
  return (
    <td
      className={cn(
        "h-11 px-3 text-fg-primary",
        align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left",
        numeric && "num font-mono tabular-nums",
        className
      )}
      {...rest}
    >
      {children}
    </td>
  );
}

export default Table;
