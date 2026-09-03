/** @type {import('tailwindcss').Config} */

// Every colour resolves through a CSS custom property declared in src/index.css so the
// palette has exactly one source of truth. The `<alpha-value>` placeholder is what lets
// opacity modifiers (`bg-keryx-green/10`) keep working against a variable.
const token = (name) => `rgb(var(--mx-${name}) / <alpha-value>)`;

export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        keryx: {
          bg: token("bg"),
          surface: token("surface"),
          border: token("border"),
          borderHi: token("border-hi"),
          bright: token("bright"),
          green: token("green"),
          mid: token("mid"),
          dim: token("dim"),
          // NOT A TEXT COLOUR. #35443a measures 1.83:1 on the card gradient — it fails even the
          // 3:1 floor for large text, and this app's labels are 9-11px. It is the site's border /
          // decoration tone; carried here to keep the palette a faithful port, and currently used
          // by nothing. For quiet text use `dim` (5.48:1), the lowest legible step.
          muted: token("muted"),
          fill: token("fill"),
          cta: token("cta"),
          onCta: token("on-cta"),
          text: token("text"),
          ink: token("ink"),
          warn: token("warn"),
          error: token("error"),
        },
      },
      fontFamily: {
        // Mono-first, like the site's app pages (<body class="font-mono">).
        mono: ["JetBrains Mono", "Fira Code", "ui-monospace", "monospace"],
        // No webfont is shipped for sans: nothing in the app uses it, and declaring a
        // face that isn't bundled is what silently downgraded the old UI to system-ui.
        sans: ["system-ui", "sans-serif"],
      },
      borderRadius: {
        // The site uses 2px on /wallet's buttons and 8px on the landing's; 6px is what
        // actually sits well next to a 10px card in a desktop window.
        sm: "6px",
        DEFAULT: "10px",
        lg: "10px",
      },
      letterSpacing: {
        label: "0.24em",
        "label-wide": "0.34em",
      },
      maxWidth: {
        // Shared by the header, <main> and the footer so they stay aligned. Sized so a MAXIMIZED
        // window on a 3440x1440 ultrawide is filled by the three columns rather than showing a
        // narrow strip down the middle — the ceiling only kicks in past that. Turn this down if
        // the rows end up feeling too sparse; it is the one knob for content width.
        content: "2600px",
      },
      boxShadow: {
        cta: "0 0 32px rgba(0,229,51,0.35)",
        card: "0 8px 30px rgba(0,0,0,0.35), 0 0 24px rgba(0,229,51,0.05)",
      },
    },
  },
  plugins: [],
};
