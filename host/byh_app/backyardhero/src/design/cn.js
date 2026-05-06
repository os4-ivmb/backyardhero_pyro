// Tiny class-list joiner. Avoids pulling clsx/cva for a console app where
// our class strings are mostly static. Filters out falsy entries so the
// `cond && "class"` idiom works.
export function cn(...parts) {
  const out = [];
  for (const p of parts) {
    if (!p) continue;
    if (typeof p === "string") out.push(p);
    else if (Array.isArray(p)) out.push(cn(...p));
    else if (typeof p === "object") {
      for (const [k, v] of Object.entries(p)) if (v) out.push(k);
    }
  }
  return out.join(" ");
}
