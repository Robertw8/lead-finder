const { NewMessage } = require("telegram/events");

const cfg = require("./src/config.js");
const { initDb } = require("./src/db.js");
const {
  prefilter,
  looksLikePromoOrBot,
  looksLikeBuySellOffer,
  looksLikeQuestionOrClaim,
  looksLikeUkrainian,
  shouldScanChatEntity,
  isSelfChannelPost,
} = require("./src/filters.js");
const { createLlm } = require("./src/llm.js");
const {
  createClient,
  resolveChatInfo,
  buildLink,
  normId,
} = require("./src/tg.js");
const { createDigest } = require("./src/digest.js");

// -------------------- лимитеры по минуте --------------------
function makeMinuteLimiter(maxPerMin) {
  let bucket = [];
  return () => {
    const now = Date.now();
    bucket = bucket.filter((t) => now - t < 60_000);
    if (bucket.length >= maxPerMin) return false;
    bucket.push(now);
    return true;
  };
}

(async () => {
  if (!cfg.tg.apiId || !cfg.tg.apiHash || !cfg.tg.session)
    throw new Error("TG_* env missing");
  if (!cfg.openai.apiKey) throw new Error("OPENAI_API_KEY missing");

  const { insertLead, getCache, putCache } = initDb("leads.db");
  const llm = createLlm(cfg.openai, cfg.llmConcurrency);

  const client = await createClient(cfg.tg);
  console.log("✅ GramJS connected");
  console.log(
    "👂 Listening ALL chats (NO private). Digest every",
    cfg.digestEverySec,
    "sec",
  );
  console.log("scanGroups:", cfg.scanGroups, "scanChannels:", cfg.scanChannels);
  console.log("heartbeat:", cfg.scanHeartbeatSec, "sec");

  const chatCache = new Map();
  const stats = {
    seen: 0,
    noText: 0,
    noChat: 0,
    skipChatType: 0,
    skipSelfPost: 0,
    skipPrefilter: 0,
    skipPromo: 0,
    skipBuySell: 0,
    skipUkrainian: 0,
    skipQuestionClaim: 0,
    skipRateLimit: 0,
    llmCalls: 0,
    llmCacheHits: 0,
    llmNotLead: 0,
    llmLowScore: 0,
    leads: 0,
    lastMessageAt: null,
    lastLeadAt: null,
  };

  // лимитеры, чтобы не жечь деньги
  const allowGlobal = makeMinuteLimiter(cfg.maxLlmPerMin);
  const perChat = new Map();
  const perUser = new Map();

  function allowForChat(chatId) {
    if (!perChat.has(chatId))
      perChat.set(chatId, makeMinuteLimiter(cfg.maxLlmPerChatPerMin));
    return perChat.get(chatId)();
  }
  function allowForUser(userId) {
    if (!userId) return true;
    if (!perUser.has(userId))
      perUser.set(userId, makeMinuteLimiter(cfg.maxLlmPerUserPerMin));
    return perUser.get(userId)();
  }

  const digest = createDigest(
    {
      everySec: cfg.digestEverySec,
      flushEveryLeads: cfg.digestFlushEveryLeads,
      maxItemsPerMessage: cfg.digestMaxItemsPerMessage,
      topLimit: cfg.digestTopLimit,
      previewChars: cfg.digestPreviewChars,
    },
    async (text) => client.sendMessage("me", { message: text }),
  );

  setInterval(() => {
    const lastMsg = stats.lastMessageAt
      ? new Date(stats.lastMessageAt).toISOString()
      : "-";
    const lastLead = stats.lastLeadAt
      ? new Date(stats.lastLeadAt).toISOString()
      : "-";
    console.log(
      `[scan] seen=${stats.seen} leads=${stats.leads} cache=${stats.llmCacheHits} llmCalls=${stats.llmCalls} skips(chatType=${stats.skipChatType},selfPost=${stats.skipSelfPost},prefilter=${stats.skipPrefilter},promo=${stats.skipPromo},buySell=${stats.skipBuySell},ua=${stats.skipUkrainian},qclaim=${stats.skipQuestionClaim},rate=${stats.skipRateLimit},noChat=${stats.noChat},noText=${stats.noText}) lastMsg=${lastMsg} lastLead=${lastLead}`,
    );
  }, cfg.scanHeartbeatSec * 1000);

  client.addEventHandler(
    async (event) => {
      const message = event.message;
      stats.seen++;
      stats.lastMessageAt = Date.now();

      const text = message?.message || "";
      if (!text) {
        stats.noText++;
        return;
      }

      const chat = await message.getChat().catch(() => null);
      if (!chat) {
        stats.noChat++;
        return;
      }

      // ❌ отрубили лички здесь
      if (
        !shouldScanChatEntity(chat, {
          scanGroups: cfg.scanGroups,
          scanChannels: cfg.scanChannels,
        })
      ) {
        stats.skipChatType++;
        if (cfg.debug) console.log("SKIP chat type:", chat.className);
        return;
      }

      const chatInfo = await resolveChatInfo(chat, chatCache);
      const sender = await message.getSender().catch(() => null);

      if (cfg.debug) {
        console.log(
          "CHAT:",
          chatInfo.title,
          chatInfo.username ? `@${chatInfo.username}` : "",
          "id=",
          chatInfo.id,
          "type=",
          chatInfo.className,
        );
        console.log("TEXT:", text.replace(/\s+/g, " ").slice(0, 100));
      }

      // не учитываем посты/авторов постов каналов
      if (isSelfChannelPost(message, sender, chat)) {
        stats.skipSelfPost++;
        return;
      }

      if (!cfg.disablePrefilter && !prefilter(text)) {
        stats.skipPrefilter++;
        return;
      }
      if (cfg.rejectPromoOrBot && looksLikePromoOrBot(text)) {
        stats.skipPromo++;
        return;
      }
      if (cfg.rejectBuySellOffers && looksLikeBuySellOffer(text)) {
        stats.skipBuySell++;
        return;
      }
      if (cfg.rejectUkrainian && looksLikeUkrainian(text)) {
        stats.skipUkrainian++;
        return;
      }
      if (cfg.requireQuestionOrClaim && !looksLikeQuestionOrClaim(text)) {
        stats.skipQuestionClaim++;
        return;
      }

      const msgId = message.id;
      const link = buildLink({
        username: chatInfo.username,
        chatId: chatInfo.id,
        msgId,
      });

      const senderId = sender?.id ? normId(sender.id) : null;

      // rate limits
      if (
        !allowGlobal() ||
        !allowForChat(chatInfo.id) ||
        !allowForUser(senderId)
      ) {
        stats.skipRateLimit++;
        if (cfg.debug) console.log("SKIP rate limit");
        return;
      }

      // cache
      const cached = getCache.get(chatInfo.id, msgId, cfg.openai.model);
      let llmRes;
      if (cached?.result_json) {
        llmRes = JSON.parse(cached.result_json);
        stats.llmCacheHits++;
      } else {
        llmRes = await llm.classifyLead({ chatTitle: chatInfo.title, text });
        stats.llmCalls++;
        putCache.run(
          chatInfo.id,
          msgId,
          cfg.openai.model,
          JSON.stringify(llmRes),
          Math.floor(Date.now() / 1000),
        );
      }

      if (!llmRes.lead) {
        stats.llmNotLead++;
        return;
      }
      if ((llmRes.score ?? 0) < cfg.leadScoreMin) {
        stats.llmLowScore++;
        return;
      }

      insertLead.run({
        chat_id: chatInfo.id,
        msg_id: msgId,
        sender_id: senderId,
        date: message.date
          ? Math.floor(new Date(message.date).getTime() / 1000)
          : null,
        chat_title: chatInfo.title,
        chat_username: chatInfo.username ? `@${chatInfo.username}` : null,
        text,
        link,
        llm_score: llmRes.score ?? 0,
        category: llmRes.category || "other",
        angle: llmRes.angle || "",
        dm1: (llmRes.dm_drafts && llmRes.dm_drafts[0]) || "",
        dm2: (llmRes.dm_drafts && llmRes.dm_drafts[1]) || "",
        why: llmRes.why || "",
        created_at: Math.floor(Date.now() / 1000),
      });

      digest.add({
        chatTitle: chatInfo.title,
        score: llmRes.score ?? 0,
        category: llmRes.category || "other",
        text,
        angle: llmRes.angle || "",
        dm1: (llmRes.dm_drafts && llmRes.dm_drafts[0]) || "",
        dm2: (llmRes.dm_drafts && llmRes.dm_drafts[1]) || "",
        link,
      });

      stats.leads++;
      stats.lastLeadAt = Date.now();
      console.log("✅ LEAD:", chatInfo.title, "score=", llmRes.score, link);
    },
    new NewMessage(cfg.scanIncomingOnly ? { incoming: true } : {}),
  );
})();
