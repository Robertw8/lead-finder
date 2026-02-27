require("dotenv").config();
const cfg = require("./src/config.js");

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const pLimit = require("p-limit").default;

const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");

const OpenAI = require("openai");

// -------------------- ENV --------------------
const apiId = cfg.tg.apiId;
const apiHash = cfg.tg.apiHash;
const sessionStr = cfg.tg.session;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

const DIGEST_EVERY_SEC = Number(process.env.DIGEST_EVERY_SEC || 120);
const LEAD_SCORE_MIN = Number(process.env.LEAD_SCORE_MIN || 60);

const DEBUG = String(process.env.DEBUG || "0") === "1";
const DISABLE_PREFILTER = String(process.env.DISABLE_PREFILTER || "0") === "1";

if (!apiId || !apiHash || !sessionStr) {
  throw new Error(
    "Заполни TG_ACCOUNT + TG_API_ID_<N>/TG_API_HASH_<N>/TG_SESSION_<N> (или базовые TG_API_ID/TG_API_HASH/TG_SESSION) в .env",
  );
}
if (!OPENAI_API_KEY) {
  throw new Error("Заполни OPENAI_API_KEY в .env");
}

// -------------------- CHATS --------------------
const chatsPath = path.join(__dirname, "chats.json");
if (!fs.existsSync(chatsPath)) {
  throw new Error("Создай chats.json рядом со scanner.cjs");
}
const chatsConfig = JSON.parse(fs.readFileSync(chatsPath, "utf8"));
const rawInclude = (chatsConfig.include || []).map(String);

// Нормализуем include:
// - "https://t.me/Name" -> "@Name"
// - "t.me/Name" -> "@Name"
// - "@Name" -> "@Name"
// - "-100..." -> "-100..."
function normalizeIncludeItem(s) {
  const t = s.trim();
  // url -> username
  const m = t.match(/t\.me\/([A-Za-z0-9_]+)/);
  if (m) return "@" + m[1];
  if (t.startsWith("@")) return t;
  // numeric id as string
  return t;
}
const INCLUDE = new Set(rawInclude.map(normalizeIncludeItem));

if (DEBUG) {
  console.log("INCLUDE normalized:", Array.from(INCLUDE));
}

// -------------------- DB --------------------
const db = new Database("leads.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    chat_id TEXT NOT NULL,
    msg_id INTEGER NOT NULL,
    sender_id TEXT,
    date INTEGER,
    text TEXT,
    link TEXT,
    llm_score INTEGER,
    category TEXT,
    angle TEXT,
    dm1 TEXT,
    dm2 TEXT,
    why TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, msg_id)
  );

  CREATE TABLE IF NOT EXISTS llm_cache (
    chat_id TEXT NOT NULL,
    msg_id INTEGER NOT NULL,
    model TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, msg_id, model)
  );
`);

const insertLead = db.prepare(`
  INSERT OR IGNORE INTO leads(
    chat_id,msg_id,sender_id,date,text,link,llm_score,category,angle,dm1,dm2,why,created_at
  ) VALUES (
    @chat_id,@msg_id,@sender_id,@date,@text,@link,@llm_score,@category,@angle,@dm1,@dm2,@why,@created_at
  )
`);

const getCache = db.prepare(
  `SELECT result_json FROM llm_cache WHERE chat_id=? AND msg_id=? AND model=?`,
);
const putCache = db.prepare(
  `INSERT OR REPLACE INTO llm_cache(chat_id,msg_id,model,result_json,created_at) VALUES(?,?,?,?,?)`,
);

// -------------------- HELPERS --------------------
function normId(id) {
  if (id == null) return null;
  const v = id.value ?? id;
  return typeof v === "bigint" ? v.toString() : String(v);
}

function buildLink({ username, chatId, msgId }) {
  if (username) return `https://t.me/${username}/${msgId}`;

  // приватные супергруппы: https://t.me/c/<internal>/<msgId>
  const absId = Math.abs(Number(chatId));
  const internal =
    absId > 1_000_000_000_000 ? absId - 1_000_000_000_000 : absId;
  return `https://t.me/c/${internal}/${msgId}`;
}

// дешёвый предфильтр — экономит API
function prefilter(text) {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 20) return false;

  const low = t.toLowerCase();

  // отсекаем типичный спам/рефки/линки
  if (
    /(t\.me\/|bit\.ly|tinyurl|ref|реф|airdrop|giveaway|promo|промо|скидк)/.test(
      low,
    )
  )
    return false;

  // короткий флуд
  if (/^(gm|gn|lol|ок|ага|да|нет|\+\+|👍|🔥)$/i.test(t)) return false;

  // много ссылок
  const urlCount = (t.match(/https?:\/\/|t\.me\//g) || []).length;
  if (urlCount >= 2) return false;

  return true;
}

function clampInt(n, min, max) {
  const x = Number(n);
  if (Number.isNaN(x)) return min;
  return Math.max(min, Math.min(max, Math.round(x)));
}

// -------------------- OPENAI --------------------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
// ограничим параллелизм
const limit = pLimit(2);

async function classifyLeadLLM({ chatTitle, text }) {
  const prompt = `
Ты анализируешь сообщения из крипто-чата и ищешь "лиды" — любые сообщения, по которым можно органично начать личное общение.

ЛИД — если можно:
- задать уточняющий вопрос,
- предложить помощь/совет,
- мягко поспорить (контраргумент),
- поддержать/сочувствовать,
- обсудить мнение/историю/эмоцию,
- зацепиться за сомнение/неопределенность/предупреждение о скаме.

НЕ ЛИД — если это:
- реклама, рефки, прямой маркетинг,
- копипаста/сигналы без контекста,
- односложный флуд,
- бессодержательные реакции.

Верни ТОЛЬКО валидный JSON (без текста вокруг), формат:
{
  "lead": true|false,
  "score": 0-100,
  "category": "question|problem|opinion|debate|story|fear|brag|scam|other",
  "angle": "как зайти в личку (1-2 предложения, по делу)",
  "dm_drafts": ["короткий DM #1", "короткий DM #2"],
  "why": "почему это лид/не лид (1 предложение)"
}

Чат: ${chatTitle}
Сообщение: """${text}"""
`;

  const resp = await openai.responses.create({
    model: MODEL,
    input: prompt,
    max_output_tokens: 220,
  });

  const out = (resp.output_text || "").trim();
  const a = out.indexOf("{");
  const b = out.lastIndexOf("}");
  if (a === -1 || b === -1) throw new Error("LLM output has no JSON");

  const jsonStr = out.slice(a, b + 1);
  const data = JSON.parse(jsonStr);

  data.lead = !!data.lead;
  data.score = clampInt(data.score, 0, 100);
  data.category = String(data.category || "other");
  data.angle = String(data.angle || "");
  data.why = String(data.why || "");

  const drafts = Array.isArray(data.dm_drafts) ? data.dm_drafts : [];
  data.dm_drafts = [
    String(drafts[0] || "").slice(0, 220),
    String(drafts[1] || "").slice(0, 220),
  ];

  return data;
}

// -------------------- MAIN --------------------
(async () => {
  const client = new TelegramClient(
    new StringSession(sessionStr),
    apiId,
    apiHash,
    {
      connectionRetries: 5,
    },
  );

  await client.connect();
  console.log("✅ GramJS connected");
  console.log(
    "👂 Listening… (new messages). Digest every",
    DIGEST_EVERY_SEC,
    "sec",
  );

  // кеш инфы по чатам
  const chatCache = new Map(); // chatId -> {id, username, title}

  async function resolveChatInfo(chatEntity) {
    const id = normId(chatEntity.id);
    if (chatCache.has(id)) return chatCache.get(id);

    const username = chatEntity.username || null;
    const title =
      chatEntity.title || chatEntity.firstName || chatEntity.username || id;

    const info = { id, username, title };
    chatCache.set(id, info);
    return info;
  }

  function isIncluded(chatInfo) {
    if (chatInfo.username && INCLUDE.has(`@${chatInfo.username}`)) return true;
    if (INCLUDE.has(chatInfo.id)) return true;
    return false;
  }

  let buffer = [];

  async function flushDigest() {
    if (!buffer.length) return;

    const top = buffer.sort((a, b) => b.score - a.score).slice(0, 15);

    const lines = top.map((x, i) => {
      const preview = (x.text || "").replace(/\s+/g, " ").slice(0, 180);
      return `${i + 1}) [${x.chatTitle}] score=${x.score} cat=${x.category}
${preview}
Зацепка: ${x.angle || "-"}
DM1: ${x.dm1 || "-"}
DM2: ${x.dm2 || "-"}
${x.link}
`;
    });

    const msg = `🧲 Leads (${top.length})\n\n` + lines.join("\n");
    await client.sendMessage("me", { message: msg });

    buffer = [];
  }

  setInterval(() => {
    flushDigest().catch((e) => console.error("digest error:", e));
  }, DIGEST_EVERY_SEC * 1000);

  client.addEventHandler(
    async (event) => {
      const message = event.message;
      const text = message?.message || "";

      if (DEBUG)
        console.log("EVENT NewMessage id=", message?.id, "len=", text.length);

      const chat = await message.getChat().catch(() => null);
      if (!chat) {
        if (DEBUG) console.log("SKIP: no chat");
        return;
      }

      const chatInfo = await resolveChatInfo(chat);

      if (DEBUG) {
        console.log(
          "CHAT:",
          chatInfo.title,
          chatInfo.username ? `@${chatInfo.username}` : "",
          "id=",
          chatInfo.id,
        );
        console.log("TEXT:", text.replace(/\s+/g, " ").slice(0, 100));
      }

      if (!isIncluded(chatInfo)) {
        if (DEBUG) console.log("SKIP: chat not in include");
        return;
      }

      if (!DISABLE_PREFILTER && !prefilter(text)) {
        if (DEBUG) console.log("SKIP: prefilter");
        return;
      }

      const msgId = message.id;

      const link = buildLink({
        username: chatInfo.username,
        chatId: chatInfo.id,
        msgId,
      });

      const sender = await message.getSender().catch(() => null);
      const senderId = sender?.id ? normId(sender.id) : null;

      // LLM cache
      const cached = getCache.get(chatInfo.id, msgId, MODEL);
      let llm;
      if (cached?.result_json) {
        llm = JSON.parse(cached.result_json);
        if (DEBUG) console.log("LLM: cache hit", llm.score);
      } else {
        if (DEBUG) console.log("LLM: request...");
        llm = await limit(() =>
          classifyLeadLLM({ chatTitle: chatInfo.title, text }),
        );
        putCache.run(
          chatInfo.id,
          msgId,
          MODEL,
          JSON.stringify(llm),
          Math.floor(Date.now() / 1000),
        );
        if (DEBUG)
          console.log("LLM: done score=", llm.score, "lead=", llm.lead);
      }

      if (!llm.lead) {
        if (DEBUG) console.log("SKIP: llm lead=false");
        return;
      }
      if ((llm.score ?? 0) < LEAD_SCORE_MIN) {
        if (DEBUG) console.log("SKIP: llm score low", llm.score);
        return;
      }

      insertLead.run({
        chat_id: chatInfo.id,
        msg_id: msgId,
        sender_id: senderId,
        date: message.date
          ? Math.floor(new Date(message.date).getTime() / 1000)
          : null,
        text,
        link,
        llm_score: llm.score ?? 0,
        category: llm.category || "other",
        angle: llm.angle || "",
        dm1: (llm.dm_drafts && llm.dm_drafts[0]) || "",
        dm2: (llm.dm_drafts && llm.dm_drafts[1]) || "",
        why: llm.why || "",
        created_at: Math.floor(Date.now() / 1000),
      });

      buffer.push({
        chatTitle: chatInfo.title,
        score: llm.score ?? 0,
        category: llm.category || "other",
        text,
        angle: llm.angle || "",
        dm1: (llm.dm_drafts && llm.dm_drafts[0]) || "",
        dm2: (llm.dm_drafts && llm.dm_drafts[1]) || "",
        link,
      });

      console.log("✅ LEAD:", chatInfo.title, "score=", llm.score, link);
    },
    new NewMessage({ incoming: true }),
  );
})();
