//! Counts user-visible characters in a model note before showing the length warning.
export function modelNoteTooLong(note: string): boolean {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(note.trim())].length > 5;
}
