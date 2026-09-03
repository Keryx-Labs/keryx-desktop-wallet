/// <reference types="vite/client" />

declare module "*.wasm?url" {
  const src: string;
  export default src;
}

declare module "*.png" {
  const src: string;
  export default src;
}

/** Injected by vite.config.ts from package.json; shown in the footer. */
declare const __APP_VERSION__: string;
