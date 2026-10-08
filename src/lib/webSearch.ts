import { byteLength } from "./chatStore";

// Client side of the web search: decide when a question needs the web, ask the site's relay
// (or a user-chosen one), and fold the results into the prompt the way Keryx facts are.

export type WebMode = "auto" | "on" | "off";
export const DEFAULT_WEB_ENDPOINT = "https://keryx-labs.com/web/search";
const WEB_MODE_KEY = "keryx.chat.webMode";
const WEB_ENDPOINT_KEY = "keryx.chat.webEndpoint";

export interface WebSource {
  title: string;
  url: string;
}

export interface WebSearchResult {
  engine: string;
  fetchedAt: string;
  query: string;
  results: { title: string; url: string; snippet: string }[];
}

// Cues that a question needs current information: time words, news, "what is going on", prices and
// markets, weather, results, releases, and events. Whole words for languages written with spaces.
const WORD_CUES: string[] = [
  // English
  "latest", "today'?s?", "tonight", "yesterday", "tomorrow", "this (morning|afternoon|evening|week|weekend|month|year|season)",
  "last (night|week|weekend|month|year)", "next (week|month|year)", "right now", "as of (now|today)", "at the moment",
  "currently", "current", "nowadays", "these days", "recent(ly)?", "news", "headlines?", "breaking", "live (score|stream|updates?|coverage|results?)",
  "update[sd]?", "what['’]?s (happening|going on|new|up with)", "what is (happening|going on)", "what happened", "going on (in|with|at)",
  "any news", "news (about|on|from)", "(any|the|latest) (info|information|updates?) (on|about)", "is it true that", "still alive",
  "who (won|wins|is winning|is leading|is|was)", "when (is|was|does|did|will)", "(president|prime minister|chancellor|ceo|leader|mayor|governor|king|pope) of",
  "elections?", "polls?", "voting", "vote", "(election|match|game|race|vote) results?", "results? of the", "scores?", "standings", "fixtures?",
  "price(s)? (of|for)", "how much (is|does|are|do|cost)", "cost of", "what['’]?s the price", "what is the price", "worth (now|today)", "market cap", "stocks?", "share price", "exchange rate",
  "inflation", "interest rates?", "weather", "forecast", "temperature (in|at|today)", "release(d| date)?", "launch(ed|es)?",
  "announce[ds]?", "announcement", "trending", "viral", "outage", "is [a-z0-9.]+ down", "wars?", "conflict", "attacks?", "invasion",
  "ceasefire", "earthquake", "hurricane", "typhoon", "wildfires?", "floods?", "strikes?", "protests?", "riots?", "crisis", "scandal",
  "died", "death of", "arrested", "resign(s|ed)?",
  // French
  "aujourd['’]hui", "hier", "demain", "ce (matin|soir|week-end|mois)", "cette (semaine|année|nuit|saison)", "la semaine (dernière|prochaine)",
  "le mois dernier", "l['’]an dernier", "l['’]année dernière", "en ce moment", "actuellement", "à l['’]heure actuelle", "de nos jours",
  "actuel(le)?s?", "récemment", "récent(e)?s?", "derni(er|ère)s? (nouvelles|infos|informations|actus?|news|chiffres|version|sortie|résultats)",
  "actualités?", "actus?", "infos?", "nouvelles", "flash info", "en direct", "mises? à jour",
  "(il|ça|ca) se passe quoi", "qu['’]est[- ]ce qu['’]il se passe", "qu['’]est[- ]ce qui se passe", "que se passe[- ]t[- ]il", "quoi de (neuf|nouveau)",
  "où en (est|sont)", "(des|les|tes|de nouvelles|d['’]autres) (infos?|informations|nouvelles) (sur|de|du|des|à propos)",
  "situation (actuelle|en|à|au|aux)", "est[- ]ce vrai que", "toujours (en vie|vivant)", "qui a gagné", "qui gagne", "qui (est|sera) (le|la) (nouveau|nouvelle|président|présidente|premier|première)",
  "(président|présidente|premier ministre|pdg|maire|roi|pape) (de|du|des)", "élections?", "sondages?", "scrutin", "résultats? (du|de la|des|de l['’]) ?(match|élection|vote|scrutin|course|loto|référendum)?",
  "score", "classement", "match", "prix (du|de la|de l['’]|des|d['’])", "combien (coûte|vaut|coûtent|valent|ça coûte)", "cours (du|de la|de l['’]|des)",
  "(vaut|valent|coûte|coute|coûtent) combien", "(ça|ca) (coûte|coute|vaut) combien", "combien (ça|ca) (coûte|coute|vaut)", "quel est le prix", "cours actuel",
  "taux de change", "taux d['’]intérêt", "bourse", "météo", "prévisions?", "température (à|en|au)", "sortie (du|de la|de l['’]|des)",
  "lancement", "annonces?", "annoncée?s?", "tendances?", "buzz", "panne", "guerres?", "conflits?", "attaques?", "attentats?", "invasion",
  "cessez[- ]le[- ]feu", "séisme", "tremblement de terre", "ouragan", "tempête", "inondations?", "incendies?", "grèves?", "manifestations?",
  "blocages?", "émeutes?", "crise", "scandale", "mort de", "décès de", "arrêtée?", "démission",
  // Spanish
  "hoy", "ayer", "mañana", "esta (semana|noche|mañana|tarde)", "este (mes|año|fin de semana)", "ahora mismo", "actualmente", "actual(es)?",
  "en este momento", "recientemente", "recientes?", "últim[oa]s? (noticias|novedades|versión|resultados)", "noticias?", "novedades", "titulares",
  "en (vivo|directo)", "última hora", "qué (está pasando|pasa|pasó|ha pasado)", "quién (ganó|gana|es el (nuevo|presidente))", "resultados? (del|de la|de las)",
  "marcador", "clasificación", "partido", "elecciones?", "encuestas?", "precios? (de|del)", "cuánto (cuesta|vale|cuestan|valen)", "a cuánto está", "vale cuánto", "cotización",
  "tipo de cambio", "bolsa", "inflación", "clima", "pronóstico", "lanzamiento", "anuncio", "guerras?", "conflicto", "ataques?", "atentado",
  "terremoto", "huracán", "inundaciones?", "incendios?", "huelgas?", "protestas?", "manifestaciones?", "crisis",
  // German
  "heute", "gestern", "morgen", "diese (woche|nacht)", "dieses (jahr|wochenende)", "diesen monat", "letzte (woche|nacht)", "im moment",
  "gerade", "aktuell(e|en|er|es)?", "derzeit", "momentan", "zurzeit", "neueste[nrs]?", "neuigkeiten", "nachrichten", "schlagzeilen",
  "was (ist|passiert|geht) (los|gerade)", "was ist passiert", "wer hat gewonnen", "wer gewinnt", "ergebnisse?", "spielstand", "tabelle",
  "wahl(en)?", "umfragen?", "preis (von|für|des|der)", "wie viel kostet", "was kostet", "kurs (von|des|der)", "wechselkurs", "börse", "aktien?(kurs)?",
  "wetter", "vorhersage", "veröffentlich(t|ung)", "erscheinungsdatum", "krieg", "konflikt", "angriff", "anschlag", "erdbeben",
  "überschwemmung(en)?", "streiks?", "proteste?", "demonstration(en)?", "krise",
  // Italian
  "oggi", "ieri", "domani", "stasera", "questa (settimana|sera|mattina)", "quest['’]anno", "questo (mese|anno|weekend)", "in questo momento",
  "attualmente", "attuale", "ultimamente", "recent[ei]", "ultime (notizie|novità)", "notizie", "novità", "in diretta",
  "cosa (succede|sta succedendo|è successo)", "chi ha vinto", "risultat[oi] (della|del|delle)", "classifica", "partita", "elezioni",
  "sondaggi?o?", "prezzo (di|del|della|dei)", "quanto (costa|vale)", "quotazione", "tasso di cambio", "borsa", "meteo", "previsioni",
  "lancio", "guerra", "conflitto", "attacco", "attentato", "terremoto", "uragano", "alluvione", "incendio", "sciopero", "prote(sta|ste)",
  "manifestazion[ei]", "crisi",
  // Portuguese
  "hoje", "ontem", "amanhã", "esta (semana|noite)", "este (mês|ano)", "neste momento", "agora mesmo", "atualmente", "atua(l|is)",
  "recentemente", "recentes?", "últimas notícias", "notícias?", "novidades", "ao vivo", "o que (está acontecendo|aconteceu|acontece)",
  "quem ganhou", "placar", "classificação", "eleiç(ão|ões)", "pesquisa eleitoral", "preço (do|da|de|dos)", "quanto (custa|vale)", "cotação",
  "câmbio", "previsão do tempo", "lançamento", "guerra", "conflito", "ataque", "atentado", "terremoto", "furacão", "enchentes?",
  "incêndios?", "greves?", "protestos?", "manifestaç(ão|ões)", "crise",
  // Dutch
  "vandaag", "gisteren", "deze week", "dit jaar", "op dit moment", "momenteel", "actueel", "nieuws", "laatste nieuws",
  "wat is er aan de hand", "wat gebeurt er", "wie heeft gewonnen", "uitslag", "verkiezingen", "prijs van", "hoeveel kost", "koers",
  "weerbericht", "oorlog", "aanslag", "aardbeving", "staking",
  // Polish
  "dzisiaj", "dziś", "wczoraj", "jutro", "w tym (tygodniu|roku|miesiącu)", "obecnie", "aktualnie", "aktualn(e|y|a)", "wiadomości",
  "najnowsze", "co się (dzieje|stało)", "kto wygrał", "wynik(i)? (meczu|wyborów)", "wybory", "cena", "ile kosztuje", "kurs (dolara|euro|walut)",
  "pogoda", "wojna", "atak", "zamach", "trzęsienie ziemi", "strajk", "protesty?",
  // Russian and Ukrainian
  "сегодня", "вчера", "завтра", "сейчас", "на этой неделе", "в этом году", "в данный момент", "актуальн\\p{L}*", "последние новости",
  "новост\\p{L}*", "что (происходит|случилось)", "кто (выиграл|победил)", "результат\\p{L}* выбор\\p{L}*", "выбор\\p{L}*", "цен[аы]",
  "сколько стоит", "курс\\p{L}*", "погода", "прогноз\\p{L}*", "войн\\p{L}*", "конфликт\\p{L}*", "атак\\p{L}*", "теракт\\p{L}*",
  "землетрясени\\p{L}*", "забастовк\\p{L}*", "протест\\p{L}*", "кризис\\p{L}*",
  "сьогодні", "вчора", "зараз", "новини", "що (відбувається|сталося)", "війна", "ціна", "погода",
  // Turkish
  "bugün", "dün", "yarın", "bu (hafta|yıl|ay)", "şu anda", "şimdi", "güncel", "son dakika", "haberler?", "son haberler",
  "neler oluyor", "ne oldu", "kim kazandı", "seçim(ler)?", "fiyatı?", "ne kadar", "döviz kuru", "hava durumu", "savaş", "saldırı",
  "deprem", "grev", "protesto", "kriz",
  // Indonesian / Malay
  "hari ini", "kemarin", "besok", "minggu ini", "tahun ini", "sekarang", "saat ini", "terkini", "terbaru", "berita",
  "apa yang terjadi", "siapa yang menang", "pemilu", "pemilihan", "harga", "berapa harga", "kurs", "cuaca", "perang", "serangan",
  "gempa", "mogok", "krisis",
  // Vietnamese
  "hôm nay", "hôm qua", "ngày mai", "tuần này", "năm nay", "hiện nay", "hiện tại", "bây giờ", "mới nhất", "tin tức",
  "chuyện gì (đang xảy ra|đã xảy ra)", "ai (thắng|đã thắng)", "kết quả (trận|bầu cử)", "bầu cử", "giá (vàng|xăng|bao nhiêu|cổ phiếu|bitcoin)",
  "tỷ giá", "thời tiết", "chiến tranh", "tấn công", "động đất", "đình công", "biểu tình", "khủng hoảng",
];
// Languages without spaces between words, or with prefixes glued to words: matched anywhere.
const SUBSTRING_CUES: string[] = [
  // Chinese (simplified and traditional)
  "今天", "昨天", "明天", "今晚", "本周", "这周", "這週", "这个月", "今年", "现在", "現在", "目前", "当前", "當前", "最近", "最新",
  "新闻", "新聞", "消息", "头条", "頭條", "直播", "发生了什么", "發生了什麼", "怎么回事", "怎麼回事", "谁赢了", "誰贏了", "比分",
  "选举", "選舉", "价格", "價格", "多少钱", "多少錢", "股价", "股價", "汇率", "匯率", "天气", "天氣", "预报", "預報", "发布", "發布",
  "局势", "局勢", "形势", "形勢", "近况", "近況", "动态", "動態", "实时", "實時", "刚刚", "剛剛", "热搜", "熱搜", "最新进展", "最新進展",
  "现任", "現任", "股市", "行情", "币价", "幣價", "怎么样了", "怎麼樣了", "进展", "進展",
  "战争", "戰爭", "冲突", "衝突", "袭击", "襲擊", "地震", "台风", "颱風", "洪水", "罢工", "罷工", "抗议", "抗議", "危机", "危機",
  // Japanese
  "今日", "きょう", "昨日", "明日", "今夜", "今週", "今月", "最新", "ニュース", "速報", "何が起き", "何があった", "誰が勝", "選挙",
  "現在", "現職", "情勢", "状況", "どうなって", "何が起こって", "最新情報", "トレンド", "ライブ", "相場", "価格", "選挙結果", "首相は誰",
  "値段", "いくら", "株価", "為替", "天気", "予報", "発売", "紛争", "攻撃", "台風", "ストライキ", "デモ",
  // Korean
  "오늘", "어제", "내일", "이번 주", "올해", "지금", "현재", "최근", "최신", "뉴스", "속보", "무슨 일", "누가 이겼", "선거", "가격",
  "상황", "요즘", "근황", "실시간", "어떻게 되고", "어떻게 됐", "무슨 일이", "현직", "대통령은 누구", "시세", "정세", "동향",
  "얼마", "주가", "환율", "날씨", "전쟁", "공격", "지진", "파업", "시위",
  // Thai
  "วันนี้", "เมื่อวาน", "ตอนนี้", "ล่าสุด", "ข่าว", "เกิดอะไรขึ้น", "ใครชนะ", "เลือกตั้ง", "ราคา", "อากาศ", "สงคราม",
  // Arabic
  "اليوم", "أمس", "غدا", "الآن", "حاليا", "هذا الأسبوع", "هذا العام", "آخر الأخبار", "أخبار", "عاجل", "ماذا يحدث", "ماذا حدث",
  "حاليًا", "حالياً", "مستجدات", "ما الجديد", "الوضع في", "آخر التطورات", "نتيجة المباراة", "سعر الصرف", "البورصة", "الأسهم", "من هو رئيس", "مباشر",
  "من فاز", "انتخابات", "سعر", "كم يكلف", "الطقس", "حرب", "هجوم", "زلزال", "إضراب", "احتجاج", "أزمة",
  // Urdu
  "آج", "خبریں", "تازہ ترین", "کیا ہو رہا ہے", "کس نے جیتا", "انتخابات", "موسم", "جنگ",
  // Hebrew
  "היום", "אתמול", "עכשיו", "חדשות", "מה קורה", "מי ניצח", "בחירות", "מחיר", "מזג אוויר", "מלחמה", "פיגוע", "רעידת אדמה",
  // Persian
  "امروز", "دیروز", "اکنون", "اخبار", "چه خبر", "انتخابات", "قیمت", "آب و هوا", "جنگ", "حمله", "زلزله",
  // Hindi
  "आज", "अभी", "ताज़ा", "ताजा", "समाचार", "ख़बर", "खबर", "क्या हो रहा", "किसने जीता", "चुनाव", "कीमत", "मौसम", "युद्ध", "हमला", "भूकंप", "हड़ताल",
];
// The message asks to look its question up: the query is then the previous question.
const SEARCH_REQUEST = new RegExp(
  "(?<!\\p{L})(" +
    [
      "(cherche|recherche|regarde|vérifie|verifie|trouve)[- ]?(le|la|les|ça|ca|moi)? ?(sur|dans) (le |l['’])?(net|internet|web|google)",
      "(cherche|recherche|regarde|vérifie|verifie) en ligne", "fais une recherche", "google[- ]?(le|la|ça|ca)",
      "(search|look|check)( it| that| this)? (up )?(on|in) (the )?(web|internet|net|google)", "search (the web|online|for it)",
      "look (it|that|this) up", "check online", "google it",
      "busca(lo|la)? en (internet|la web|google)", "búscalo", "such(e)? (im internet|online|es im netz)", "google (es|das)",
      "cerca (su|in) (internet|google|rete)", "pesquisa (na|no) (internet|google|web)", "поищи в (интернете|сети)", "загугли",
      "internette ara", "cari di (internet|google)",
    ].join("|") +
    ")(?!\\p{L})",
  "iu"
);
const SEARCH_REQUEST_CJK = /上网查|网上查|網上查|搜一下|搜索一下|查一下|ネットで調べ|検索して|調べて|검색해|인터넷에서 찾아|찾아봐|ابحث في الإنترنت|ابحث على الإنترنت|ابحث في جوجل|ابحث عن/u;

/** Whether `text` asks the assistant to search the web for the conversation's question. */
export function isSearchRequest(text: string): boolean {
  return SEARCH_REQUEST.test(text) || SEARCH_REQUEST_CJK.test(text);
}

const WORD_RE = new RegExp(`(?<!\\p{L})(${WORD_CUES.join("|")})(?!\\p{L})`, "iu");
const SUBSTRING_RE = new RegExp(SUBSTRING_CUES.join("|"), "u");
const EXPLICIT = /^\s*(search|web|google|cherche|recherche|buscar|busca|suche|cerca)\s*[:：]\s*/i;

/** Past this length a message carries its own material (article, code, log): no automatic search. */
const AUTO_MAX_CHARS = 1_500;

/** Whether `text` is long enough to be pasted material rather than a question. */
export function isLongMessage(text: string): boolean {
  return text.length > AUTO_MAX_CHARS;
}

/** Whether `question` asks for something the model cannot know without the web. */
export function isWebQuestion(question: string): boolean {
  if (EXPLICIT.test(question)) return true;
  if (isLongMessage(question)) return false;
  return isSearchRequest(question) || WORD_RE.test(question) || SUBSTRING_RE.test(question);
}

/** The question stripped of an explicit `search:` prefix. */
export function stripWebPrefix(question: string): string {
  return question.replace(EXPLICIT, "").trim();
}

export function loadWebMode(): WebMode {
  try {
    const v = localStorage.getItem(WEB_MODE_KEY);
    return v === "on" || v === "off" ? v : "auto";
  } catch {
    return "auto";
  }
}

export function saveWebMode(mode: WebMode): void {
  try {
    localStorage.setItem(WEB_MODE_KEY, mode);
  } catch {
    // Browser storage refused: the choice lasts for this page only.
  }
}

export function loadWebEndpoint(): string {
  try {
    return localStorage.getItem(WEB_ENDPOINT_KEY)?.trim() || DEFAULT_WEB_ENDPOINT;
  } catch {
    return DEFAULT_WEB_ENDPOINT;
  }
}

export function saveWebEndpoint(endpoint: string): void {
  try {
    const v = endpoint.trim();
    if (v && v !== DEFAULT_WEB_ENDPOINT) localStorage.setItem(WEB_ENDPOINT_KEY, v);
    else localStorage.removeItem(WEB_ENDPOINT_KEY);
  } catch {
    // Browser storage refused: the choice lasts for this page only.
  }
}

const FILLER = /^(please|can you|could you|tell me|what is|what's|peux-tu|dis-moi|qu'est-ce que|c'est quoi|j'ai entendu dire que|on dit que|il para[îi]t que)\s+/i;
const OPINION = /\s*,?\s*(tu en penses quoi|qu'en penses-tu|t'en penses quoi|what do you think( about it)?|your thoughts)\s*\??\s*$/i;

/** A search query from a chat question: one line, filler dropped, at most 200 characters.
 *  A follow-up keeps the gist of the previous question so the search stays on topic. */
/** Fewest words a follow-up needs to be searched without the previous question. */
const STANDALONE_MIN_WORDS = 4;

export function searchQueryOf(question: string, previousQuestion?: string): string {
  const clean = (t: string) => stripWebPrefix(t).replace(/\s+/g, " ").replace(FILLER, "").replace(OPINION, "").trim();
  let q = clean(question);
  if (previousQuestion && isSearchRequest(question)) {
    const rest = clean(question.replace(new RegExp(SEARCH_REQUEST.source, "giu"), " ").replace(new RegExp(SEARCH_REQUEST_CJK.source, "gu"), " "))
      .replace(/^[\s\p{P}]*(ben|bah|eh bien|alors|ok|okay|so|well|then|vas[- ]y|go)?[\s\p{P}]*/iu, "")
      .replace(/[\s\p{P}]+$/u, "");
    q = rest.split(/\s+/).filter(Boolean).length >= 3 ? rest : "";
  }
  // A message that asks for current information in its own words keeps its own subject.
  const standalone = q.split(/\s+/).filter(Boolean).length >= STANDALONE_MIN_WORDS && isWebQuestion(q);
  if (previousQuestion && !standalone) {
    const prev = clean(previousQuestion).replace(OPINION, "");
    const topic = prev.length > 80 ? prev.slice(0, 80) : prev;
    if (topic && !q.toLowerCase().includes(topic.toLowerCase().slice(0, 24))) q = `${topic} ${q}`.trim();
  }
  if (!q) q = clean(question);
  return q.length > 200 ? q.slice(0, 200) : q;
}

export async function searchWeb(
  question: string,
  endpoint: string = DEFAULT_WEB_ENDPOINT,
  previousQuestion?: string,
  timeoutMs = 8_000
): Promise<WebSearchResult> {
  const query = searchQueryOf(question, previousQuestion);
  const u = new URL(endpoint, window.location.origin);
  u.searchParams.set("q", query);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(u.toString(), { signal: controller.signal });
    const body = (await res.json().catch(() => ({}))) as Partial<WebSearchResult> & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `search relay ${res.status}`);
    return { engine: body.engine ?? "?", fetchedAt: body.fetchedAt ?? new Date().toISOString(), query, results: body.results ?? [] };
  } finally {
    clearTimeout(timer);
  }
}

const HEADER =
  "WEB SEARCH RESULTS — today is %DATE%. Fetched at %TIME% for the query \"%QUERY%\". They are more current than your training data: " +
  "prefer them for anything recent, factual or numeric; the date line above already answers questions about today. " +
  "Cite a result as [n] right after the fact it supports. " +
  "Dates and years must come from the results, copied exactly; never shift a year from memory. " +
  "If they do not cover the question, say so instead of guessing. " +
  "Use only names, titles, numbers, dates and acronyms that appear in these results or in the conversation: " +
  "never add people, positions, figures or acronym expansions from memory.\n\n";
const FOOTER = "\n";

/** The results block for the prompt, at most `maxBytes`; the sources it kept, in order. */
export function buildWebContext(search: WebSearchResult, maxBytes: number): { block: string; sources: WebSource[] } {
  const header = HEADER
    .replace("%DATE%", new Date(search.fetchedAt).toUTCString().replace(/ \d\d:\d\d:\d\d GMT$/, "") + " (" + search.fetchedAt.slice(0, 10) + ")")
    .replace("%TIME%", search.fetchedAt.replace(/\.\d{3}Z$/, "Z"))
    .replace("%QUERY%", search.query.replace(/"/g, "'"));
  let block = header;
  const sources: WebSource[] = [];
  for (const r of search.results) {
    const entry = `[${sources.length + 1}] ${r.title}\n${r.url}\n${r.snippet}\n\n`;
    if (byteLength(block) + byteLength(entry) + byteLength(FOOTER) > maxBytes) break;
    block += entry;
    sources.push({ title: r.title, url: r.url });
  }
  if (sources.length === 0) return { block: "", sources: [] };
  return { block: block + FOOTER, sources };
}
