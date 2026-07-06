// Minimal, dependency-free ZIP reader for the import flow.
//
// A Finale3D ".fin" show is just a ZIP archive whose entries we need to read
// (STORE or DEFLATE). Rather than pull in a zip library, we parse the central
// directory ourselves and decompress DEFLATE entries with the browser-native
// `DecompressionStream("deflate-raw")` — supported in modern Chromium /
// Electron / Node, so the whole import stays client-side with no new deps.
//
// Only the small slice the importer needs is implemented: read named entries
// out of an archive as bytes / text. No ZIP64, no encryption.

const EOCD_SIG = 0x06054b50; // end of central directory
const CD_SIG = 0x02014b50; // central directory file header

function u16(dv, off) {
  return dv.getUint16(off, true);
}
function u32(dv, off) {
  return dv.getUint32(off, true);
}

// Raw DEFLATE (ZIP stores no zlib wrapper) → bytes, via the platform stream.
async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error(
      "This environment can't unzip archives (DecompressionStream unavailable).",
    );
  }
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

// Parse an ArrayBuffer as a ZIP and return a Map of entryName -> Uint8Array.
export async function readZip(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const dv = new DataView(arrayBuffer);

  // Locate the EOCD by scanning backward from the end (comment is normally
  // empty; cap the search at the max 64KB comment).
  let eocd = -1;
  const min = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (u32(dv, i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error("Not a ZIP archive (no end-of-central-directory record).");
  }

  const entryCount = u16(dv, eocd + 10);
  let cdOff = u32(dv, eocd + 16);
  const decoder = new TextDecoder();
  const entries = new Map();

  for (let e = 0; e < entryCount; e++) {
    if (u32(dv, cdOff) !== CD_SIG) break;
    const method = u16(dv, cdOff + 10);
    const compSize = u32(dv, cdOff + 20);
    const nameLen = u16(dv, cdOff + 28);
    const extraLen = u16(dv, cdOff + 30);
    const commentLen = u16(dv, cdOff + 32);
    const localOff = u32(dv, cdOff + 42);
    const name = decoder.decode(bytes.subarray(cdOff + 46, cdOff + 46 + nameLen));

    // The local header repeats name/extra with possibly different lengths;
    // recompute the data offset from it (the central dir sizes are canonical).
    const lNameLen = u16(dv, localOff + 26);
    const lExtraLen = u16(dv, localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = bytes.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = comp;
    else if (method === 8) data = await inflateRaw(comp);
    else throw new Error(`Unsupported ZIP compression method ${method} ("${name}").`);

    entries.set(name, data);
    cdOff += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// Convenience: pull one entry out as UTF-8 text, or null if it isn't present.
export async function readZipTextEntry(arrayBuffer, name) {
  const entries = await readZip(arrayBuffer);
  const data = entries.get(name);
  if (!data) return null;
  return new TextDecoder().decode(data);
}
