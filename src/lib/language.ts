// Guess the language of a chat message, so the prompt can end with a short instruction written in
// that language: small models follow it far better than an English "reply in the user's language".

/** Reply instruction, in its own language, by language code. */
const REPLY_IN: Record<string, string> = {
  fr: "Réponds en français.",
  en: "Reply in English.",
  es: "Responde en español.",
  de: "Antworte auf Deutsch.",
  it: "Rispondi in italiano.",
  pt: "Responda em português.",
  nl: "Antwoord in het Nederlands.",
  pl: "Odpowiedz po polsku.",
  tr: "Türkçe yanıt ver.",
  id: "Jawab dalam bahasa Indonesia.",
  vi: "Hãy trả lời bằng tiếng Việt.",
  ru: "Отвечай на русском языке.",
  uk: "Відповідай українською мовою.",
  zh: "请用中文回答。",
  ja: "日本語で答えてください。",
  ko: "한국어로 답변해 주세요.",
  ar: "أجب باللغة العربية.",
  fa: "به فارسی پاسخ بده.",
  ur: "اردو میں جواب دیں۔",
  he: "ענה בעברית.",
  th: "ตอบเป็นภาษาไทย",
  hi: "हिंदी में उत्तर दें।",
  el: "Απάντησε στα ελληνικά.",
};

// Frequent short words per Latin-script language; a message is scored by how many it contains.
const STOPWORDS: Record<string, string[]> = {
  fr: ["le", "la", "les", "un", "une", "des", "du", "de", "et", "est", "je", "tu", "il", "elle", "nous", "vous", "que", "qui", "quoi", "pour", "pas", "sur", "dans", "avec", "ce", "ça", "ca", "mon", "ton", "moi", "toi", "salut", "bonjour", "merci", "combien", "comment", "pourquoi", "quel", "quelle", "aussi", "mais", "ou", "où", "c'est", "j'ai", "tu as", "peux", "donne", "explique"],
  en: ["the", "a", "an", "and", "is", "are", "was", "i", "you", "he", "she", "we", "they", "what", "who", "how", "why", "which", "for", "not", "on", "in", "with", "this", "that", "my", "your", "me", "hi", "hello", "thanks", "please", "can", "could", "do", "does", "give", "tell", "of", "to", "it's", "what's"],
  es: ["el", "la", "los", "las", "un", "una", "y", "es", "son", "yo", "tú", "usted", "qué", "quién", "cómo", "por", "para", "no", "en", "con", "este", "esta", "mi", "hola", "gracias", "cuánto", "cuál", "puedes", "dame", "pero", "también", "del", "al"],
  de: ["der", "die", "das", "ein", "eine", "und", "ist", "sind", "ich", "du", "sie", "wir", "was", "wer", "wie", "warum", "für", "nicht", "auf", "mit", "dieser", "mein", "dein", "hallo", "danke", "bitte", "kannst", "gib", "aber", "auch", "von", "zu", "den", "dem", "los", "heute", "gibt", "es", "wo", "wann", "welche", "ist", "geht", "kostet"],
  it: ["il", "lo", "la", "gli", "le", "un", "una", "e", "è", "sono", "io", "tu", "lui", "noi", "voi", "che", "chi", "come", "perché", "per", "non", "su", "con", "questo", "mio", "ciao", "grazie", "quanto", "puoi", "dammi", "ma", "anche", "del", "della", "cosa", "sta", "succede", "oggi", "dove", "quando", "c'è", "qual", "sei"],
  pt: ["o", "a", "os", "as", "um", "uma", "e", "é", "são", "eu", "você", "ele", "nós", "que", "quem", "como", "por", "para", "não", "em", "com", "este", "meu", "olá", "oi", "obrigado", "obrigada", "quanto", "pode", "mas", "também", "do", "da", "no", "na"],
  nl: ["de", "het", "een", "en", "is", "zijn", "ik", "jij", "je", "hij", "wij", "wat", "wie", "hoe", "waarom", "voor", "niet", "op", "met", "deze", "mijn", "hallo", "dank", "bedankt", "kun", "geef", "maar", "ook", "van"],
  pl: ["i", "jest", "są", "ja", "ty", "on", "my", "co", "kto", "jak", "dlaczego", "dla", "nie", "na", "w", "z", "ten", "mój", "cześć", "dziękuję", "ile", "możesz", "ale", "też", "się", "czy"],
  tr: ["ve", "bir", "bu", "ne", "kim", "nasıl", "neden", "için", "değil", "ile", "benim", "senin", "merhaba", "teşekkürler", "lütfen", "kaç", "ama", "da", "de", "mi", "mı", "nedir"],
  id: ["dan", "yang", "ini", "itu", "saya", "aku", "kamu", "anda", "apa", "siapa", "bagaimana", "kenapa", "untuk", "tidak", "di", "ke", "dari", "dengan", "halo", "terima", "kasih", "berapa", "bisa", "tapi", "juga", "adalah"],
  vi: ["và", "là", "của", "có", "không", "tôi", "bạn", "anh", "chị", "gì", "ai", "như", "thế", "nào", "tại", "sao", "cho", "với", "này", "đó", "xin", "chào", "cảm", "ơn", "bao", "nhiêu", "được", "những", "các"],
};
const STOPWORD_SETS = Object.fromEntries(Object.entries(STOPWORDS).map(([k, v]) => [k, new Set(v)]));

/** Language code of `text`, or `null` when the guess is not clear. */
export function detectLanguage(text: string): string | null {
  const t = text.slice(0, 2_000);
  const count = (re: RegExp) => (t.match(re) ?? []).length;
  if (count(/[぀-ヿ]/g) >= 2) return "ja";
  if (count(/[가-힯]/g) >= 2) return "ko";
  if (count(/[一-鿿]/g) >= 2) return "zh";
  if (count(/[؀-ۿ]/g) >= 3) {
    if (count(/[ےٹڈڑںھ]/g) >= 1) return "ur";
    if (count(/[پچژگکی]/g) >= 1) return "fa";
    return "ar";
  }
  if (count(/[֐-׿]/g) >= 3) return "he";
  if (count(/[฀-๿]/g) >= 3) return "th";
  if (count(/[ऀ-ॿ]/g) >= 3) return "hi";
  if (count(/[Ͱ-Ͽ]/g) >= 3) return "el";
  if (count(/[Ѐ-ӿ]/g) >= 3) return count(/[іїєґ]/gi) >= 1 ? "uk" : "ru";

  const words = t.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  if (words.length === 0) return null;
  const scores = Object.entries(STOPWORD_SETS).map(([lang, set]) => [lang, words.filter((w) => set.has(w)).length] as const);
  if (count(/[ạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹđ]/gi) >= 2) return "vi";
  scores.sort((a, b) => b[1] - a[1]);
  const [best, second] = scores;
  if (best[1] === 0 || best[1] === second[1]) return null;
  return best[0];
}

/** One line telling the model which language to answer in, written in that language; empty when unsure. */
export function replyLanguageLine(text: string): string {
  const lang = detectLanguage(text);
  return lang ? REPLY_IN[lang] : "";
}
