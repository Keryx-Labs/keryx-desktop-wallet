/**
 * Palette hexes for the few consumers that can't read CSS custom properties — canvas
 * drawing, mainly. Keep in sync with the :root block in src/index.css, which stays the
 * source of truth for everything styled in CSS.
 */
export const palette = {
  bg: "#070a08",
  surface: "#0c110d",
  border: "#1c2a20",
  bright: "#30ff67",
  green: "#2ee358",
  dim: "#4f9a60",
  onCta: "#04120a",
} as const;
