const DEFAULT_SETTINGS = {
  provider: "openai_responses",
  apiKey: "",
  model: "gpt-4.1-mini",
  apiBase: "https://api.openai.com/v1",
  api2dBase: "https://oa.api2d.net/v1",
  defaultLanguage: "zh",
  defaultStyle: "sharp",
  maxChineseChars: 24,
  maxEnglishWords: 22,
  maxJapaneseChars: 28, 
  bannedWords: "我觉得,值得关注,持续看好,赋能,生态,未来可期,多维度,深度解析,感谢分享,确实如此,听起来,看起来,哇,真不错,想试试,太猛了,兄弟们,不仅,更是",
  projectHandle: "",
  customPrompt: "",
  debugMode: false
};

const STYLE_MAP = {
  sharp: "默认风格：短、有判断、有棱角，像真实 KOL 随手回复，不端着，不油腻"
};

function log(...args) {
  if (globalThis.__AKIII_DEBUG__) console.log("[Akiii Reply]", ...args);
}

function normalizeBase(base, fallback) {
  const raw = String(base || fallback || "").trim().replace(/\/+$/, "");
  return raw || fallback;
}

function getEffectiveProvider(settings) {
  const key = String(settings.apiKey || "").trim();
  // API2D 的 Forward Key 通常是 fk 开头。用户如果误选 OpenAI 官方接口，
  // OpenAI 会直接返回 Incorrect API key。这里自动切到 API2D，减少小白配置成本。
  if (/^fk/i.test(key)) return "api2d";
  return settings.provider || DEFAULT_SETTINGS.provider;
}

function explainApiError(errorMessage, settings) {
  const msg = String(errorMessage || "");
  const key = String(settings.apiKey || "").trim();
  const effective = getEffectiveProvider(settings);

  if (/incorrect api key|invalid api key|401|unauthorized/i.test(msg)) {
    if (/^fk/i.test(key)) {
      return "你填的是 fk 开头的 Key，像 API2D/中转 Key。请在插件里选择 API2D / Chat Completions，或使用官方 OpenAI 的 sk- / sk-proj- Key。";
    }
    if (effective === "openai_responses" && !/^sk-/i.test(key)) {
      return "当前选择的是 OpenAI 官方接口，但这个 Key 不像官方 OpenAI Key。官方 Key 通常以 sk- 或 sk-proj- 开头。";
    }
    return "API Key 不正确或已失效。请重新复制完整 Key，确认没有空格，并保存后刷新 X 页面。";
  }

  return msg || "接口请求失败";
}

async function getSettings() {
  const saved = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const settings = { ...DEFAULT_SETTINGS, ...saved };
  globalThis.__AKIII_DEBUG__ = Boolean(settings.debugMode);
  return settings;
}

function parseList(text) {
  return String(text || "")
    .split(/[，,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function unique(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function getSmallestRepeatedSegment(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  const compact = s.replace(/\s+/g, '');
  if (compact.length < 6) return null;

  for (let unitLen = 2; unitLen <= Math.floor(compact.length / 2); unitLen++) {
    if (compact.length % unitLen !== 0) continue;
    const unit = compact.slice(0, unitLen);
    const repeatCount = compact.length / unitLen;
    if (repeatCount < 2) continue;
    if (unit.repeat(repeatCount) !== compact) continue;

    let seen = '';
    for (let i = 0; i < s.length; i++) {
      if (!/\s/.test(s[i])) seen += s[i];
      if (seen === unit) return s.slice(0, i + 1).trim();
    }
    return unit;
  }
  return null;
}

function dedupeRepeatedText(text) {
  let s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return s;

  // 连续压缩多次，处理“同一句复制 2/3/4 遍”的情况。
  for (let round = 0; round < 5; round++) {
    const before = s;
    const smallest = getSmallestRepeatedSegment(s);
    if (smallest && smallest.length < s.length) s = smallest;

    for (let i = Math.floor(s.length / 2) - 3; i <= Math.floor(s.length / 2) + 3; i++) {
      if (i <= 0 || i >= s.length) continue;
      const a = s.slice(0, i).trim();
      const b = s.slice(i).trim();
      if (a && a === b) {
        s = a;
        break;
      }
    }

    const parts = s.split(/(?<=[。！？!?；;])\s*|\s{2,}/).map((x) => x.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const out = [];
      for (const part of parts) {
        const bare = part.replace(/[。.!！?？；;]+$/g, '').trim();
        const last = out.length ? out[out.length - 1].replace(/[。.!！?？；;]+$/g, '').trim() : '';
        if (bare && bare !== last) out.push(part);
      }
      s = out.join(' ').trim();
    }

    if (s === before) break;
  }

  return s;
}

function maybeRepairMojibake(text) {
  const raw = String(text || "");
  if (!raw) return raw;
  const chineseCount = (raw.match(/[\u4e00-\u9fff]/g) || []).length;
  const weirdCount = (raw.match(/[ÃÂÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ�]/g) || []).length;
  const looksBroken = weirdCount >= 3 && chineseCount === 0;
  if (!looksBroken) return raw;

  const candidates = [];
  try {
    const bytes = Uint8Array.from(Array.from(raw, (ch) => ch.charCodeAt(0) & 0xff));
    candidates.push(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (_) {}

  try {
    // 处理常见的 UTF-8 被当 Latin-1 读出的情况，如 ä¸­æ–‡
    candidates.push(decodeURIComponent(escape(raw)));
  } catch (_) {}

  for (const candidate of candidates) {
    const cChinese = (candidate.match(/[\u4e00-\u9fff]/g) || []).length;
    const cBroken = (candidate.match(/�/g) || []).length;
    if (cChinese > chineseCount && cBroken === 0) return candidate;
  }
  return raw;
}

function looksLikeBrokenText(text) {
  const s = String(text || "");
  if (!s.trim()) return true;
  if ((s.match(/�/g) || []).length > 0) return true;
  // 常见乱码碎片：ä¸­æ–‡ / æˆ‘ / Ã© 等
  const suspicious = (s.match(/[ÃÂÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]/g) || []).length;
  const chinese = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  return suspicious >= 4 && chinese === 0;
}

function buildInstructions(settings, payload) {
  const mergedBanned = unique([...parseList(settings.bannedWords), ...parseList(payload.extraBannedWords)]).join("、") || "无";
  const styleId = payload.style || settings.defaultStyle || "sharp";
  
  // 判断语言
  let language = payload.language || settings.defaultLanguage;
  if (payload.language === "ja") language = "ja";
  
  let lengthRule = "";
  let languageRule = "";
  
  if (language === "ja") {
    lengthRule = `原推文主要是日文，本次必须用日文回复，尽量控制在 10-${settings.maxJapaneseChars || 28} 个日文字符左右，只输出一条回复`;
    languageRule = `日文回复规则：
- 使用自然的口语体（です・ます体或简体均可，根据语境选择）
- 像真实用户在刷推时的随手评论
- 可以用「めっちゃ」「超」「やばい」「さすが」「マジで」「なるほど」等自然口语词
- 不要过于敬语化，不要像客服或机器人
- 句子要短，节奏快`;
  } else if (language === "en") {
    lengthRule = `原推文主要是英文，本次必须用英文回复，大约 ${settings.maxEnglishWords || 22} 个英文单词，只输出一条回复，不要附中文翻译`;
    languageRule = `英文回复：自然口语化，不要中式英语，像真实用户在刷推评论`;
  } else {
    lengthRule = `原推文主要是中文，本次必须用中文回复，尽量控制在 10-${settings.maxChineseChars || 24} 个中文字符左右，只输出一条回复`;
    languageRule = `中文回复规则：
- 用词口语化、自然，像微信聊天或刷推随手评论
- 可以用“兄弟”、“哥们”、“老铁”等亲切称呼，不要过度
- 可以有感叹、反问、调侃、佩服、吐槽
- 句子要短，节奏快
- 可以用“看来”、“确实”、“真心”、“真的”这类真实语气词`;
  }

  return `你是 Akiii 的 X / Twitter 回复生成器。你的任务是为用户的推文生成一条真实、接地气的评论区回复。

【核心要求】
生成的回复必须像真人在刷推随手打出来的，不要像AI、不要像营销号、不要像客服。

【语气参考样例】
中文样例：
- "平台上线只是第一步，后续跟兄弟们一起撸起袖子干，这波机会抓稳了。"
- "这节奏太猛了，带病还这么拼，真心佩服你的韧劲和执行力。"
- "看来被骚扰确实是一种流量认证，没这待遇都不好意思说自己是KOL了。"
- "祝阿姨福如东海，快乐每一天！"
- "之前没留意到积分和粉丝双重门槛，看来得先提升一下自己的粉丝数了。"

日文样例：
- "マジでこれやばいっすね"
- "さすがです！完全に同意"
- "めっちゃわかります、それな"
- "お大事に！早く良くなってください"

【回复写作规则】
1. 用词口语化、自然，像刷推随手评论
2. 句子要短，节奏快，一句话能说完的事不要分两句
3. 该佩服就佩服，该调侃就调侃，该祝贺就祝贺，不要端着
4. 不要写成总结、不要解释背景、不要教育读者
5. 不要使用 emoji，除非原推文本身风格需要
6. 不要加标题、引号、前缀、换行、编号
7. 不要输出“回复：”“评论：”“Here is”等任何说明文字

【硬性禁止】
- 禁止空话套话
- 禁止太完整的论述
- 禁止造作句式

${languageRule}

【长度规则】
${lengthRule}

【禁用词】
${mergedBanned}

【项目方规则】
如果推文明确涉及某个项目或账号，可以在回复中自然提到；没有的话绝对不要编造。

【输出要求】
- 只输出最终回复这一句话
- 不要有任何解释、前缀、后缀、换行
- 不要输出乱码、�、HTML实体
${settings.customPrompt ? `\n用户额外要求：${settings.customPrompt}` : ""}`;
}

function buildInput(settings, payload) {
  const author = payload.author || "未知";
  const authorHandle = payload.authorHandle || "";
  const mentioned = unique(Array.isArray(payload.mentionedHandles) ? payload.mentionedHandles : []);
  const manualHandle = payload.projectHandle || settings.projectHandle || "";
  const usableHandles = unique([manualHandle, ...mentioned]).join(" ") || "无";

  return `请根据下面这条推文，生成一条评论区回复。

推文作者：${author}${authorHandle ? ` ${authorHandle}` : ""}
可用项目方 @账号：${usableHandles}
用户指定禁用词：${payload.extraBannedWords || "无"}
页面来源：${payload.url || "无"}

推文内容：
${payload.tweetText || ""}`;
}

function stripNoise(text) {
  let s = maybeRepairMojibake(String(text || ""));
  s = s
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ""))
    .replace(/^[\s"'“”‘’`]+|[\s"'“”‘’`]+$/g, "")
    .replace(/^(回复|评论|答案|输出|Reply|Comment|Answer)\s*[:：]\s*/i, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  const cutMarkers = ["中文：", "翻译：", "Translation:", "Chinese:", "中文翻译", "解释："];
  for (const marker of cutMarkers) {
    const idx = s.indexOf(marker);
    if (idx > 0) s = s.slice(0, idx).trim();
  }

  return s;
}

function cleanReply(text, settings, payload) {
  let reply = dedupeRepeatedText(stripNoise(text));
  const language = payload.language || settings.defaultLanguage;

  if (language === "en") {
    const words = reply.split(/\s+/).filter(Boolean);
    const limit = Math.max(Number(settings.maxEnglishWords || 22) + 8, 14);
    if (words.length > limit) reply = words.slice(0, limit).join(" ");
  } else if (language === "ja") {
    // 日语按字符数限制
    const max = Math.max(Number(settings.maxJapaneseChars || 28) + 10, 30);
    if (Array.from(reply).length > max) {
      reply = Array.from(reply).slice(0, max).join("");
    }
  } else {
    // 中文
    const max = Math.max(Number(settings.maxChineseChars || 24) + 18, 30);
    if (Array.from(reply).length > max) {
      const firstClause = reply.split(/[。！？!?；;\n]/).map((s) => s.trim()).find(Boolean);
      reply = firstClause && Array.from(firstClause).length <= max ? firstClause : Array.from(reply).slice(0, max).join("");
    }
  }

  reply = dedupeRepeatedText(reply);
  reply = reply.replace(/[。.]$/g, "").trim();
  return reply;
}

function hasBannedWord(reply, settings, payload) {
  const words = unique([...parseList(settings.bannedWords), ...parseList(payload.extraBannedWords)]);
  return words.some((word) => word && reply.includes(word));
}

function removeBannedWords(reply, settings, payload) {
  let s = reply;
  for (const word of unique([...parseList(settings.bannedWords), ...parseList(payload.extraBannedWords)])) {
    if (!word) continue;
    s = s.split(word).join("");
  }
  return s.replace(/\s{2,}/g, " ").trim();
}

async function requestResponses(settings, instructions, input) {
  const base = normalizeBase(settings.apiBase, DEFAULT_SETTINGS.apiBase);
  const response = await fetch(`${base}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Authorization": `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model || DEFAULT_SETTINGS.model,
      instructions,
      input,
      temperature: 0.85,
      max_output_tokens: 160
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(explainApiError(data?.error?.message || `OpenAI Responses 请求失败：${response.status}`, settings));
  }
  if (typeof data.output_text === "string") return data.output_text;

  const parts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) parts.push(content.text);
      else if (typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

async function requestChatCompletions(settings, instructions, input) {
  const provider = getEffectiveProvider(settings);
  const isApi2d = provider === "api2d";
  const base = normalizeBase(isApi2d ? settings.api2dBase : settings.apiBase, isApi2d ? DEFAULT_SETTINGS.api2dBase : DEFAULT_SETTINGS.apiBase);
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Authorization": `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model || DEFAULT_SETTINGS.model,
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: input }
      ],
      temperature: 0.85,
      max_tokens: 160
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(explainApiError(data?.error?.message || `Chat Completions 请求失败：${response.status}`, settings));
  }
  return data?.choices?.[0]?.message?.content || "";
}

async function callModel(settings, instructions, input) {
  const provider = getEffectiveProvider(settings);
  if (provider === "openai_responses") return requestResponses(settings, instructions, input);
  return requestChatCompletions(settings, instructions, input);
}

async function generateReply(payload) {
  const settings = await getSettings();
  if (!settings.apiKey || !settings.apiKey.trim()) {
    throw new Error("请先点击插件图标，在设置里保存 API Key");
  }

  const merged = {
    ...payload,
    style: payload.style || "sharp",
    language: payload.language || settings.defaultLanguage
  };

  const input = buildInput(settings, merged);
  let instructions = buildInstructions(settings, merged);
  let lastReply = "";

  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await callModel(settings, instructions, input);
    const reply = cleanReply(raw, settings, merged);
    lastReply = reply;
    log("reply attempt", attempt + 1, reply);

    if (reply && !hasBannedWord(reply, settings, merged) && !looksLikeBrokenText(reply)) {
      return reply;
    }

    instructions += `\n\n上一次输出不合格：${looksLikeBrokenText(reply) ? "出现乱码或空内容" : "包含禁用词或太像模板"}。请重新生成，只输出一句正常文本回复，必须避开禁用词。`;
  }

  let fallback = cleanReply(removeBannedWords(lastReply, settings, merged), settings, merged);
  if (!fallback || looksLikeBrokenText(fallback)) fallback = merged.language === "en" ? "This one actually needs a closer look" : "这事还真不能只看表面";
  return fallback;
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const existing = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const init = {};
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (existing[key] === undefined) init[key] = value;
  }
  if (Object.keys(init).length) await chrome.storage.local.set(init);
  if (details.reason === "install") chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === "generateReply") {
    generateReply(message.payload || {})
      .then((reply) => sendResponse({ ok: true, reply }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.action === "getSettings") {
    getSettings()
      .then((settings) => sendResponse({ ok: true, settings: { ...settings, apiKey: settings.apiKey ? "***" : "" } }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
});
