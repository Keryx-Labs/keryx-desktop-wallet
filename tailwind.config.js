/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        keryx: {
          green: "#4ade80",
          teal: "#2dd4bf",
          dark: "#0a0f0d",
          panel: "#111a16",
          border: "#1f2d27",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(74,222,128,0.25), 0 0 24px -6px rgba(74,222,128,0.35)",
      },
    },
  },
  plugins: [],
};
