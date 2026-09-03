/**
 * The wallet has one screen (Home) and a set of overlays. The key identifies which
 * overlay is open; it lives in App so both the header nav and Home's buttons can open
 * the same thing.
 */
export type ModalKey =
  | "send"
  | "receive"
  | "consolidate"
  | "chat"
  | "addresses"
  | "settings";
