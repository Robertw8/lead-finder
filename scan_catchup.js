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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dateSec(value) {
  if (value == null) return null;
  const d = value?.date != null ? value.date : value;
  if (typeof d === "number") return d;
  if (d instanceof Date) return Math.floor(d.getTime() / 1000);
  const t = new Date(d).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor(t / 1000);
}

function msgDateSec(msg) {
  return dateSec(msg?.date);
}

function dialogActivitySec(dialog) {
  return (
    dateSec(dialog?.date) ??
    dateSec(dialog?.message?.date) ??
    dateSec(dialog?.dialog?.date) ??
    dateSec(dialog?.entity?.date) ??
    0
  );
}

(async () => {
  if (!cfg.tg.apiId || !cfg.tg.apiHash || !cfg.tg.session)
    throw new Error("TG_* env missing");
  if (!cfg.openai.apiKey) throw new Error("OPENAI_API_KEY missing");

  const { insertLead, getCache, putCache } = initDb("leads.db");
  const llm = createLlm(cfg.openai, cfg.llmConcurrency);
  const client = await createClient(cfg.tg);
  const startedAt = Date.now();

  console.log("✅ GramJS connected");
  console.log(
    "👂 Hybrid mode: realtime + catchup. Digest every",
    cfg.digestEverySec,
    "sec",
  );
  console.log("scanGroups:", cfg.scanGroups, "scanChannels:", cfg.scanChannels);
  console.log("incomingOnly:", cfg.scanIncomingOnly);
  console.log(
    "catchup:",
    cfg.scanCatchupEnabled
      ? `on every ${cfg.scanCatchupEverySec}s lookback=${cfg.scanCatchupLookbackMin}m dialogs=${cfg.scanCatchupDialogsLimit}/${cfg.scanCatchupDialogsPoolLimit} perChat=${cfg.scanCatchupPerChatLimit} rotate=${cfg.scanCatchupRotateDialogs ? "on" : "off"}`
      : "off",
  );
  console.log(
    "maxRuntimeSec:",
    cfg.scanCatchupMaxRuntimeSec > 0 ? cfg.scanCatchupMaxRuntimeSec : "off",
  );

  const chatCache = new Map();
  const stats = {
    seen: 0,
    realtimeSeen: 0,
    catchupSeen: 0,
    noText: 0,
    noChat: 0,
    skipOutgoing: 0,
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
    catchupRuns: 0,
    catchupChats: 0,
    lastMessageAt: null,
    lastLeadAt: null,
    lastCatchupAt: null,
  };

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

  let heartbeatTimer = null;
  let catchupInterval = null;
  let stopTimer = null;
  let stopping = false;
  let catchupDialogCursor = 0;

  async function gracefulStop(reason) {
    if (stopping) return;
    stopping = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (catchupInterval) clearInterval(catchupInterval);
    if (stopTimer) clearTimeout(stopTimer);

    console.log(`[scan+] stopping: ${reason}`);
    try {
      await digest.flush();
    } catch (e) {
      console.error("final digest flush error:", e?.message || e);
    }
    const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);
    console.log(`[scan+] stopped. uptimeSec=${uptimeSec} leads=${stats.leads}`);
    process.exit(0);
  }

  async function processMessage(message, chatHint, source) {
    if (stopping) return;
    stats.seen++;
    if (source === "realtime") stats.realtimeSeen++;
    if (source === "catchup") stats.catchupSeen++;
    stats.lastMessageAt = Date.now();

    const text = message?.message || "";
    if (!text) {
      stats.noText++;
      return;
    }

    const chat = chatHint || (await message.getChat().catch(() => null));
    if (!chat) {
      stats.noChat++;
      return;
    }

    if (
      !shouldScanChatEntity(chat, {
        scanGroups: cfg.scanGroups,
        scanChannels: cfg.scanChannels,
      })
    ) {
      stats.skipChatType++;
      return;
    }

    if (cfg.scanIncomingOnly && message?.out) {
      stats.skipOutgoing++;
      return;
    }

    const sender = await message.getSender().catch(() => null);
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

    const chatInfo = await resolveChatInfo(chat, chatCache);
    const msgId = message.id;
    const link = buildLink({
      username: chatInfo.username,
      chatId: chatInfo.id,
      msgId,
    });
    const senderId = sender?.id ? normId(sender.id) : null;

    if (
      !allowGlobal() ||
      !allowForChat(chatInfo.id) ||
      !allowForUser(senderId)
    ) {
      stats.skipRateLimit++;
      return;
    }

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

    const saved = insertLead.run({
      chat_id: chatInfo.id,
      msg_id: msgId,
      sender_id: senderId,
      date: msgDateSec(message),
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

    // не дублируем одинаковые лиды в digest при catchup/realtime пересечении
    if (!saved?.changes) return;

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
    console.log(
      `✅ LEAD [${source}]`,
      chatInfo.title,
      "score=",
      llmRes.score,
      link,
    );
  }

  let catchupRunning = false;
  async function runCatchup() {
    if (stopping) return;
    if (!cfg.scanCatchupEnabled || catchupRunning) return;
    catchupRunning = true;
    try {
      const sinceSec =
        Math.floor(Date.now() / 1000) - cfg.scanCatchupLookbackMin * 60;
      const poolLimit = Math.max(
        cfg.scanCatchupDialogsPoolLimit,
        cfg.scanCatchupDialogsLimit,
      );
      const rawDialogs = await client.getDialogs({
        limit: poolLimit,
      });
      const dialogsByActivity = [...rawDialogs].sort(
        (a, b) => dialogActivitySec(b) - dialogActivitySec(a),
      );
      let dialogs = dialogsByActivity;
      if (
        cfg.scanCatchupRotateDialogs &&
        dialogsByActivity.length > cfg.scanCatchupDialogsLimit
      ) {
        const size = dialogsByActivity.length;
        const start = catchupDialogCursor % size;
        const rotated = [];
        for (let i = 0; i < cfg.scanCatchupDialogsLimit; i++) {
          rotated.push(dialogsByActivity[(start + i) % size]);
        }
        dialogs = rotated;
        catchupDialogCursor =
          (start + cfg.scanCatchupDialogsLimit) % dialogsByActivity.length;
      } else {
        dialogs = dialogsByActivity.slice(0, cfg.scanCatchupDialogsLimit);
      }

      let scannedChats = 0;
      for (const d of dialogs) {
        if (stopping) break;
        const entity = d.entity;
        const peer = d.inputEntity || d.entity;

        if (
          !shouldScanChatEntity(entity, {
            scanGroups: cfg.scanGroups,
            scanChannels: cfg.scanChannels,
          })
        ) {
          continue;
        }

        scannedChats++;
        let processedInChat = 0;
        for await (const msg of client.iterMessages(peer, {
          limit: cfg.scanCatchupPerChatLimit,
        })) {
          if (stopping) break;
          processedInChat++;
          if (
            cfg.scanCatchupMsgPauseEvery > 0 &&
            cfg.scanCatchupMsgPauseMs > 0 &&
            processedInChat % cfg.scanCatchupMsgPauseEvery === 0
          ) {
            await sleep(cfg.scanCatchupMsgPauseMs);
          }
          const sec = msgDateSec(msg);
          if (sec != null && sec < sinceSec) break;
          await processMessage(msg, entity, "catchup");
        }

        if (cfg.scanCatchupChatDelayMs > 0) {
          await sleep(cfg.scanCatchupChatDelayMs);
        }
      }

      stats.catchupRuns++;
      stats.catchupChats += scannedChats;
      stats.lastCatchupAt = Date.now();
      console.log(
        `[catchup] done runs=${stats.catchupRuns} scannedChats=${scannedChats} pool=${dialogsByActivity.length} cursor=${catchupDialogCursor} lookbackMin=${cfg.scanCatchupLookbackMin}`,
      );
    } catch (e) {
      console.error("[catchup] error:", e?.message || e);
    } finally {
      catchupRunning = false;
    }
  }

  heartbeatTimer = setInterval(() => {
    const lastMsg = stats.lastMessageAt
      ? new Date(stats.lastMessageAt).toISOString()
      : "-";
    const lastLead = stats.lastLeadAt
      ? new Date(stats.lastLeadAt).toISOString()
      : "-";
    const lastCatchup = stats.lastCatchupAt
      ? new Date(stats.lastCatchupAt).toISOString()
      : "-";
    console.log(
      `[scan+] seen=${stats.seen} rt=${stats.realtimeSeen} cu=${stats.catchupSeen} leads=${stats.leads} cache=${stats.llmCacheHits} llmCalls=${stats.llmCalls} skips(out=${stats.skipOutgoing},chatType=${stats.skipChatType},selfPost=${stats.skipSelfPost},prefilter=${stats.skipPrefilter},promo=${stats.skipPromo},buySell=${stats.skipBuySell},ua=${stats.skipUkrainian},qclaim=${stats.skipQuestionClaim},rate=${stats.skipRateLimit},noChat=${stats.noChat},noText=${stats.noText}) catchup(runs=${stats.catchupRuns},chats=${stats.catchupChats},last=${lastCatchup}) lastMsg=${lastMsg} lastLead=${lastLead}`,
    );
  }, cfg.scanHeartbeatSec * 1000);

  client.addEventHandler(
    async (event) => {
      await processMessage(event.message, null, "realtime");
    },
    new NewMessage(cfg.scanIncomingOnly ? { incoming: true } : {}),
  );

  if (cfg.scanCatchupEnabled) {
    await runCatchup();
    catchupInterval = setInterval(
      () => runCatchup().catch(() => {}),
      cfg.scanCatchupEverySec * 1000,
    );
  }

  if (cfg.scanCatchupMaxRuntimeSec > 0) {
    stopTimer = setTimeout(() => {
      gracefulStop(`max runtime ${cfg.scanCatchupMaxRuntimeSec}s reached`).catch(
        (e) => console.error("stop error:", e?.message || e),
      );
    }, cfg.scanCatchupMaxRuntimeSec * 1000);
  }
})();
