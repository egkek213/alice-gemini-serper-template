const DEFAULT_MODEL = "qwen/qwen3.8-27b";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 4300;
const SERPER_TIMEOUT_MS = 1400;
const GROQ_TIMEOUT_MS = 2500;

const SYSTEM_PROMPT = [
  "Ты — полезный голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай естественно, по-русски, кратко и так, чтобы ответ было удобно слушать.",
  "Обычно используй 1–3 коротких предложения. Не используй Markdown, таблицы, списки с символами или длинные вступления.",
  "Не выдумывай факты, названия, даты, цены, расписания и даты релизов.",
  "История диалога — только контекст, а не источник фактов. Предыдущие ответы ассистента могут быть ошибочными.",
  "Короткие реакции и уточнения вроде «как так», «почему так», «в смысле», «что значит», «ужас-то какой», «кошмар», «жесть», а также пояснения «я говорю…», «я имею в виду…», «я про…» обычно относятся к предыдущему ответу. Учитывай историю диалога, отвечай естественно и при необходимости признай, что неверно понял реплику. Не превращай эмоциональную реакцию в вопрос об орфографии и не запускай для неё веб-поиск.",
  "Для любых вопросов и просьб о сведениях из реального мира опирайся на веб-поиск, а не на память модели. Поиск запускается для всех содержательных запросов, кроме приветствий, обычной беседы, творческих задач, преобразования уже данного текста и простой арифметики.",
  "Результаты поиска имеют приоритет над историей и твоими знаниями. История диалога — только контекст; предыдущие ответы ассистента никогда не являются доказательством.",
  "Проверяй ключевые имена, даты, числа, характеристики и причинно-следственные утверждения по нескольким независимым результатам. По возможности отдавай приоритет официальным документам, сайтам производителей, научным публикациям и профильным источникам. Не считай несколько страниц одного сайта независимыми подтверждениями.",
  "Если источники противоречат друг другу, явно обозначь неопределённость. Не выбирай уверенно один вариант без основания и не добавляй детали, которых нет в результатах.",
  "Если результатов недостаточно для надёжного подтверждения, прямо скажи, что не удалось проверить информацию. Не заполняй пробелы догадками и не отвечай по памяти даже если тебе кажется, что ты знаешь ответ.",
  "Если не знаешь ответа, честно скажи об этом."
].join(" ");

const MONTHS = "(январ[еь]|феврал[еь]|март[еа]?|апрел[еь]|ма[йяе]|июн[еья]|июл[еья]|август[еа]?|сентябр[еь]|октябр[еь]|ноябр[еь]|декабр[еь])";

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history }
  };
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) return text || "Не удалось подготовить ответ.";

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );
  if (sentenceEnd >= 300) return candidate.slice(0, sentenceEnd + 1).trim();

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "assistant" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({
      role: item.role === "user" ? "user" : "assistant",
      text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS)
    }));
}

function isFollowUp(text) {
  const current = String(text || "").trim();
  return /^(?:а\s+)?(?:в|за|на|а\s+что|а\s+как|а\s+если|а\s+когда)(?:\s|$)/i.test(current)
    || /^(?:ужас(?:[- ]то)?\s+какой|кошмар(?:\s+какой)?|жесть|вот\s+именно|да\s+уж|капец|я\s+говорю(?:\s|$)|я\s+имею\s+в\s+виду(?:\s|$)|я\s+про(?:\s|$))/i.test(current);
}

function normalizeSearchIdentifiers(query) {
  // Search engines may treat spaced and hyphenated chip/model numbers differently.
  // Include the canonical compact form alongside the user's original wording.
  return String(query || "").replace(/\bAC[\s-]*7076[\s-]*A\b/gi, match =>
    match + " AC7076A"
  );
}

function isTimeQuestion(text) {
  return /(?:сколько\s+(?:сейчас\s+)?времени?|который\s+час|текущее\s+время|время\s+сейчас)/i.test(String(text || ""));
}

function hasTimeTopic(history = []) {
  return [...safeHistory(history)].reverse().some(item =>
    item.role === "user" && isTimeQuestion(item.text)
  );
}

function getCityTime(city) {
  const normalized = String(city || "").toLowerCase().trim().replace(/[ё]/g, "е");
  const zones = {
    "екатеринбург": "Asia/Yekaterinburg",
    "екб": "Asia/Yekaterinburg",
    "москва": "Europe/Moscow",
    "санкт-петербург": "Europe/Moscow",
    "питер": "Europe/Moscow",
    "казань": "Europe/Moscow",
    "нижний новгород": "Europe/Moscow",
    "самара": "Europe/Samara",
    "уфа": "Asia/Yekaterinburg",
    "челябинск": "Asia/Yekaterinburg",
    "пермь": "Asia/Yekaterinburg",
    "тюмень": "Asia/Yekaterinburg",
    "омск": "Asia/Omsk",
    "новосибирск": "Asia/Novosibirsk",
    "красноярск": "Asia/Krasnoyarsk",
    "иркутск": "Asia/Irkutsk",
    "якутск": "Asia/Yakutsk",
    "владивосток": "Asia/Vladivostok",
    "хабаровск": "Asia/Vladivostok",
    "калининград": "Europe/Kaliningrad"
  };
  const timeZone = zones[normalized];
  if (!timeZone) return null;
  const formatted = new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(new Date());
  return { timeZone, formatted };
}

function wasAskedForCity(history = []) {
  const lastAssistant = [...safeHistory(history)].reverse().find(item => item.role === "assistant");
  return Boolean(lastAssistant && /для какого города|в каком городе/i.test(lastAssistant.text));
}

function buildSearchQuery(text, history = [], geoCity = "") {
  const current = String(text || "").trim();
  if (wasAskedForCity(history)) {
    const city = String(geoCity || current).trim();
    return normalizeSearchIdentifiers("погода сейчас в " + city);
  }
  const priorUser = [...safeHistory(history)].reverse()
    .find(item => item.role === "user" && item.text.trim().length >= 3 && !isFollowUp(item.text));
  if (!isFollowUp(current) || !priorUser) return normalizeSearchIdentifiers(current);

  const prior = priorUser.text;
  const monthMatch = current.match(new RegExp(MONTHS, "i"));
  const priorHasMonth = new RegExp(MONTHS, "i").test(prior);
  if (monthMatch && priorHasMonth) {
    const month = monthMatch[0].toLowerCase();
    const monthName = month.startsWith("январ") ? "январь"
      : month.startsWith("феврал") ? "февраль"
      : month.startsWith("март") ? "март"
      : month.startsWith("апрел") ? "апрель"
      : month.startsWith("ма") ? "май"
      : month.startsWith("июн") ? "июнь"
      : month.startsWith("июл") ? "июль"
      : month.startsWith("август") ? "август"
      : month.startsWith("сентябр") ? "сентябрь"
      : month.startsWith("октябр") ? "октябрь"
      : month.startsWith("ноябр") ? "ноябрь"
      : "декабрь";
    const year = current.match(/\b20\d{2}\b/)?.[0] || prior.match(/\b20\d{2}\b/)?.[0] || "";
    const topic = prior
      .replace(new RegExp(MONTHS, "i"), "")
      .replace(/\b20\d{2}\b/g, "")
      .replace(/(?:^|\s)(?:за|в|на)\s*$/i, "")
      .trim();
    return [topic, monthName, year].filter(Boolean).join(" ");
  }
  return normalizeSearchIdentifiers(prior + " " + current);
}

function isSearchIntent(text, history = []) {
  const current = String(text || "").trim();
  if (!current) return false;
  if (safeHistory(history).some(item => item.role === "assistant") && (
    /^(?:как так|почему так|а почему|почему|в смысле|что значит|и что|серьёзно|серьезно|правда что|это как)\??[!. ]*$/i.test(current)
    || isFollowUp(current)
  )) return false;
  if (wasAskedForCity(history) && current.length <= 40) return true;
  if (/^(?:какая сегодня дата|какое сегодня число|сегодняшняя дата)\??$/i.test(current)) return false;

  // Ordinary conversation and non-factual tasks do not need search.
  // Do not use \b after Russian words: JavaScript word boundaries are ASCII-oriented.
  if (/^(?:привет|здравствуй|здарова|доброе утро|добрый день|добрый вечер|спасибо|благодарю|пока|до свидания|как дела(?: у тебя)?|ты как|как ты|кто ты|что ты такое)(?=$|[!.? ]+$)/i.test(current)) return false;
  if (/^(?:мне скучно|я устал|я устала|я рад|я рада|я не понимаю|мне нравится|я думаю|просто болтаю)(?=$|[!.? ]|\s)/i.test(current)) return false;
  if (/^(?:придумай|сочини|напиши|расскажи)\s+(?:мне\s+)?(?:сказк|стих|истори|шутк|анекдот|песн)/i.test(current)) return false;
  if (/^(?:переведи|перефразируй|исправь грамматику|сократи|суммируй)\s/i.test(current)) return false;
  if (/^(?:сколько будет|чему равно)\s+[\d\s()+*/.,-]+\??$/i.test(current)) return false;
  if (/^сколько будет\s+\d+\s+(?:умножить|плюс|минус|разделить)\s+на?\s+\d+\??$/i.test(current)) return false;

  // Default to web verification for every other substantive request so unfamiliar
  // topics and declarative fact requests are not silently answered from model memory.
  return true;
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;
  if (!key || timeoutMs < 150) return "";

  try {
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 5 })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );

    if (!response.ok) {
      console.warn("Serper request failed with HTTP", response.status);
      return "";
    }

    const seenDomains = new Set();
    const items = [];
    for (const item of (Array.isArray(data.organic) ? data.organic : [])) {
      const link = String(item.link || "").slice(0, 240);
      let domain = "";
      try {
        domain = new URL(link).hostname.toLowerCase().replace(/^www\\./, "");
      } catch {
        continue;
      }
      if (!domain || seenDomains.has(domain)) continue;
      seenDomains.add(domain);
      const title = String(item.title || "").slice(0, 180);
      const snippet = String(item.snippet || "").slice(0, 350);
      items.push(items.length + 1 + ". " + title + ": " + snippet + " " + link);
      if (items.length >= 5) break;
    }

    // Require at least two distinct source domains before treating search as evidence.
    if (items.length < 2) return "";
    const answerBox = data.answerBox?.answer || data.answerBox?.snippet;
    if (answerBox) items.unshift("Сводка поисковика (только дополнительная подсказка, не самостоятельное подтверждение): " + String(answerBox).slice(0, 350));
    return items.join("\n");
  } catch (error) {
    console.warn("Serper request did not finish in time; continuing without search.");
    return "";
  }
}

async function askGroq(text, history, searchContext, searchWasAttempted, timeoutMs) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("MISSING_GROQ_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(process.env.GROQ_MODEL || DEFAULT_MODEL).trim();
  if (!/^[A-Za-z0-9._/-]+$/.test(model)) throw new Error("INVALID_MODEL_NAME");

  const messages = [
    { role: "developer", content: SYSTEM_PROMPT },
    ...safeHistory(history).map(item => ({
      role: item.role,
      content: item.text
    }))
  ];

  let prompt = text;
  if (searchContext) {
    prompt += "\n\nРезультаты веб-поиска по теме запроса (источник может содержать ошибки, сверяй формулировки и даты):\n" + searchContext
      + "\nОтвечай только фактами, которые подтверждаются этими результатами. Если подтверждения нет, скажи об этом.";
  } else if (searchWasAttempted) {
    prompt += "\n\nВеб-поиск не вернул проверяемых результатов. Не отвечай на фактическую часть по памяти и не придумывай названия или даты. Скажи, что сейчас не удалось проверить информацию.";
  }
  messages.push({ role: "user", content: prompt });

  const { response, data } = await fetchJson(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + key
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        max_completion_tokens: 320,
        reasoning_effort: "low",
        reasoning_format: "hidden",
        stream: false
      })
    },
    Math.min(GROQ_TIMEOUT_MS, timeoutMs)
  );

  if (!response.ok) {
    const status = Number(response.status);
    const apiError = data?.error || {};
    // Keep the provider's diagnostic details in Vercel logs, but never log
    // request headers, API keys, or the full prompt.
    console.error("Groq API error:", JSON.stringify({
      status,
      type: apiError.type || null,
      code: apiError.code || null,
      param: apiError.param || null,
      message: String(apiError.message || "").slice(0, 500)
    }));
    if (status === 401 || status === 403) throw new Error("GROQ_KEY_REJECTED");
    if (status === 429) throw new Error("GROQ_QUOTA");
    if (status === 400) {
      const detail = String(apiError.message || "").toLowerCase();
      if (/model|model_id|model id|not found|does not exist/.test(detail)) {
        throw new Error("GROQ_MODEL_REJECTED");
      }
      throw new Error("GROQ_REQUEST_REJECTED");
    }
    throw new Error("GROQ_REQUEST_FAILED");
  }

  const answer = data?.choices?.[0]?.message?.content;
  if (typeof answer !== "string" || !answer.trim()) {
    throw new Error("GROQ_EMPTY_RESPONSE");
  }

  return answer.trim();
}

function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_GROQ_KEY":
      return "Сервер пока не настроен. Проверьте переменную GROQ_API_KEY в настройках Vercel.";
    case "GROQ_KEY_REJECTED":
      return "Не удалось подключиться к Groq. Проверьте API-ключ в настройках Vercel.";
    case "GROQ_QUOTA":
      return "Сейчас превышен лимит запросов к Groq. Попробуйте немного позже.";
    case "GROQ_MODEL_REJECTED":
      return "Groq не распознал выбранную модель. Проверьте значение GROQ_MODEL в настройках Vercel.";
    case "GROQ_REQUEST_REJECTED":
      return "Groq отклонил формат запроса. Ошибка записана в журнал сервера.";
    case "TIME_BUDGET_EXHAUSTED":
    case "AbortError":
      return "Не успела подготовить ответ. Попробуйте задать вопрос ещё раз, чуть короче.";
    default:
      return "Не получилось получить ответ от нейросети. Попробуйте ещё раз чуть позже.";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-groq-serper",
      message: "Webhook is ready. Yandex Dialogs should send POST requests to /api."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = Date.now();
  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
  const oldHistory = safeHistory(body?.state?.session?.history);

  if (!text) {
    return res.status(200).json(aliceResponse(
      "Привет! Я могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?",
      false,
      oldHistory
    ));
  }

  const geoCity = body?.request?.nlu?.entities
    ?.find(entity => entity?.type === "YANDEX.GEO")
    ?.value?.city;

  const timeFollowUp = hasTimeTopic(oldHistory) && (geoCity || /(?:^|\s)(?:в|на)\s+/i.test(text));
  if (isTimeQuestion(text) || timeFollowUp) {
    const city = geoCity || (text.match(/(?:^|\s)(?:в|на)\s+([А-ЯЁа-яё-]+)/i)?.[1]);
    if (!city) {
      const history = [
        ...oldHistory,
        { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
        { role: "assistant", text: "Для какого города назвать время?" }
      ].slice(-MAX_HISTORY_MESSAGES);
      return res.status(200).json(aliceResponse("Для какого города назвать время?", false, history));
    }
    const result = getCityTime(city);
    if (!result) {
      const history = [
        ...oldHistory,
        { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
        { role: "assistant", text: "Не удалось определить часовой пояс этого города." }
      ].slice(-MAX_HISTORY_MESSAGES);
      return res.status(200).json(aliceResponse("Пока не знаю часовой пояс этого города.", false, history));
    }
    const answer = "В городе " + city + " сейчас " + result.formatted + ".";
    const history = [
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "assistant", text: answer }
    ].slice(-MAX_HISTORY_MESSAGES);
    return res.status(200).json(aliceResponse(answer, false, history));
  }

  const isWeatherRequest = /погод[ауыое]?/i.test(text);
  const hasLocationPhrase = /(?:^|\s)в\s+[А-ЯЁа-яё-]+/i.test(text);

  // Never guess a city for a generic weather request. A short follow-up such as
  // "а в екб" will inherit the previous "погода" topic in buildSearchQuery.
  if (isWeatherRequest && !geoCity && !hasLocationPhrase) {
    const history = [
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "assistant", text: "Для какого города посмотреть погоду?" }
    ].slice(-MAX_HISTORY_MESSAGES);
    return res.status(200).json(aliceResponse("Для какого города посмотреть погоду?", false, history));
  }

  try {
    const shouldSearch = isSearchIntent(text, oldHistory);
    const searchQuery = buildSearchQuery(text, oldHistory, geoCity);
    let searchContext = "";
    if (shouldSearch) {
      searchContext = await searchWeb(searchQuery, Math.min(SERPER_TIMEOUT_MS, Math.max(0, remainingMs() - 2900)));
      if (!searchContext) {
        const history = [
          ...oldHistory,
          { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
          { role: "assistant", text: "Не удалось проверить информацию." }
        ].slice(-MAX_HISTORY_MESSAGES);
        return res.status(200).json(aliceResponse("Не удалось проверить информацию: поиск не вернул результаты вовремя.", false, history));
      }
    }

    const answer = await askGroq(
      text,
      oldHistory,
      searchContext,
      shouldSearch,
      Math.max(0, Math.min(GROQ_TIMEOUT_MS, remainingMs() - 600))
    );

    const history = [
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "assistant", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES);

    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    const safeError = error?.message === "AbortError" ? "TIME_BUDGET_EXHAUSTED" : error;
    console.warn("Alice webhook returned a fallback response:", safeError?.message || "unknown error");
    return res.status(200).json(aliceResponse(errorForUser(safeError), false, oldHistory));
  }
}

export { aliceResponse, buildSearchQuery, fitAliceText, isSearchIntent, safeHistory };
