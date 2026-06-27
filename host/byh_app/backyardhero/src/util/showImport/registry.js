// Registry of import sources and their file types.
//
// Adding a new source (or a new file type within a source) is a matter of
// writing a BaseShowConverter subclass and adding an entry here — nothing
// in the UI needs to change.

import { Finale3DBrpCsvConverter } from "./Finale3DBrpCsvConverter";

export const IMPORT_SOURCES = [
  {
    id: "finale3d",
    name: "Finale3D",
    // Drop the real logo at public/import-sources/finale3d.png. The source
    // tile falls back to the name if the asset is missing.
    logo: "/import-sources/finale3d.png",
    types: [
      {
        id: "brp_csv",
        label: "BRP CSV",
        accept: Finale3DBrpCsvConverter.accept,
        ConverterClass: Finale3DBrpCsvConverter,
      },
    ],
  },
];

export function getImportSource(sourceId) {
  return IMPORT_SOURCES.find((s) => s.id === sourceId) || null;
}

export function getImportType(sourceId, typeId) {
  const src = getImportSource(sourceId);
  if (!src) return null;
  return src.types.find((t) => t.id === typeId) || null;
}

export function createConverter(sourceId, typeId) {
  const type = getImportType(sourceId, typeId);
  if (!type) return null;
  return new type.ConverterClass();
}
