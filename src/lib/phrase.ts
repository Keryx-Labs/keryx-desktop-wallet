/**
 * Recovery-phrase text formats, shared by onboarding (the first wallet) and the wallet manager
 * (every wallet added later), so both write and read exactly the same file.
 */

export const PHRASE_FILENAME = "keryx-recovery-phrase.txt";

/**
 * The layout shared by the clipboard and the saved file: the phrase flat on one line — so it can
 * be pasted into another wallet's import box — followed by a numbered list, because the confirm
 * step asks for "word #7" and counting across a wall of text is where people slip.
 */
export function phraseBody(words: string[]): string[] {
  return [
    words.join(" "),
    "",
    ...words.map((w, i) => `${String(i + 1).padStart(2, " ")}. ${w}`),
  ];
}

/** The full .txt we hand the user: a `#` header they can't mistake, then the phrase twice. */
export function phraseFileText(words: string[]): string {
  return [
    "# KERYX WALLET RECOVERY PHRASE",
    `# ${words.length} words, in order. Anyone who reads this file can spend your funds.`,
    "# Keep it offline, and delete it from any machine you do not control.",
    `# Generated ${new Date().toISOString()}`,
    "",
    ...phraseBody(words),
    "",
  ].join("\r\n"); // CRLF so it opens readably in Notepad
}

/**
 * Read the words back out of a saved recovery-phrase file. Ours has `#` comment lines and lists
 * the phrase twice (see phraseBody), but the user may well hand us their own notes instead — so
 * when numbering is present it is authoritative, and otherwise we fall back to taking every
 * word-ish token.
 */
export function parsePhraseFile(text: string): string[] {
  const lines = text.split(/\r?\n/).filter((l) => !l.trimStart().startsWith("#"));
  const numbered = lines
    .map((l) => /^\s*(\d+)[.)]\s*([A-Za-z]+)\s*$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null);
  if (numbered.length >= 12) {
    return numbered
      .sort((a, b) => Number(a[1]) - Number(b[1]))
      .map((m) => m[2].toLowerCase());
  }
  return lines.join(" ").toLowerCase().split(/[^a-z]+/).filter(Boolean);
}
