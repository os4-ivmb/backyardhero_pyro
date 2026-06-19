// Unicode-aware digit extraction.
//
// The classic `value.replace(/\D/g, "")` only keeps ASCII 0-9: in JS `\d`
// (and therefore `\D`) is ASCII-only. On a localized Windows laptop the keys
// a user presses can produce decimal digits from a *different* script:
//
//   * an East-Asian IME emits full-width digits (０１２…, U+FF10–U+FF19)
//   * an Arabic / Persian / Urdu layout emits Arabic-Indic digits
//     (٠١٢…, U+0660–U+0669 or ۰۱۲…, U+06F0–U+06F9)
//   * various Indic / Thai / Lao layouts emit their own digit blocks
//
// Those are all "digits" to the human typing them, but `\D` treats them as
// non-digits and strips them -- so a numeric field looks like it's silently
// rejecting every keystroke (the reported "I type numbers and nothing shows
// up, like I'm typing letters" symptom).
//
// `toAsciiDigits` keeps any Unicode decimal digit and transliterates it to its
// ASCII equivalent, dropping everything else -- a drop-in, locale-safe
// replacement for `.replace(/\D/g, "")`.

// Code point of the digit "0" for each decimal-digit block a localized
// keyboard/IME realistically produces. Every block is a contiguous 0-9 run,
// so the value is simply (codePoint - zero).
const DIGIT_ZEROS = [
  0x0030, // ASCII / Latin
  0xff10, // Fullwidth (CJK IME)
  0x0660, // Arabic-Indic
  0x06f0, // Extended Arabic-Indic (Persian / Urdu)
  0x0966, // Devanagari
  0x09e6, // Bengali
  0x0a66, // Gurmukhi
  0x0ae6, // Gujarati
  0x0b66, // Oriya
  0x0be6, // Tamil
  0x0c66, // Telugu
  0x0ce6, // Kannada
  0x0d66, // Malayalam
  0x0e50, // Thai
  0x0ed0, // Lao
];

/**
 * Extract decimal digits from `input` and return them as an ASCII "0-9"
 * string, regardless of the script they were typed in. Non-digit characters
 * are dropped.
 */
export function toAsciiDigits(input) {
  if (input == null) return "";
  let out = "";
  // Iterate by code point so astral / multi-unit characters are handled.
  for (const ch of String(input)) {
    const cp = ch.codePointAt(0);
    for (const zero of DIGIT_ZEROS) {
      if (cp >= zero && cp <= zero + 9) {
        out += String(cp - zero);
        break;
      }
    }
  }
  return out;
}
