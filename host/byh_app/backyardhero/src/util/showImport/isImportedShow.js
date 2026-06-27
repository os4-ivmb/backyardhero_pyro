// Detect whether a show row was produced by the import flow.
//
// We deliberately avoid a dedicated DB column (no migration): every imported
// cue item in `display_payload` carries an `importSource` tag, so detection
// just looks for that tag. The tag is whitelisted in the builder's
// SAVEABLE_ITEM_ATTRIBUTES, so it survives a later edit/re-save.

export function getShowImportSource(show) {
  if (!show) return null;
  try {
    const payload = JSON.parse(show.display_payload || "[]");
    if (!Array.isArray(payload)) return null;
    for (const it of payload) {
      if (it && it.importSource) return it.importSource;
    }
  } catch {
    /* unparseable payloads are simply "not imported" */
  }
  return null;
}

export function isImportedShow(show) {
  return !!getShowImportSource(show);
}
