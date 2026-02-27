const cfg = require("./src/config.js");
const { initDb } = require("./src/db.js");
const {
  prefilter,
  looksLikePromoOrBot,
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
  if (typeof d === "number") return d; // unix seconds
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
  const bf = cfg.backfill;
  const dialogsLimit = bf.dialogsLimit;
  const perChatLimit = bf.perChatLimit;
  const maxLeads = bf.maxLeads;
  const perChatDelayMs = bf.chatDelayMs;
  const perMessagesPauseEvery = bf.msgPauseEvery;
  const perMessagesPauseMs = bf.msgPauseMs;
  const progressEveryChats = bf.progressEveryChats;
  const partialDigestEveryLeads = bf.partialDigestEveryLeads;
  const DRY_RUN = bf.dryRun;
  const SOFT_MODE = bf.softMode;

  if (!cfg.tg.apiId || !cfg.tg.apiHash || !cfg.tg.session)
    throw new Error("TG_* env missing");
  if (!cfg.openai.apiKey && !DRY_RUN) throw new Error("OPENAI_API_KEY missing");

  const now = new Date();
  const dayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    0,
    0,
    0,
    0,
  );
  const sinceMs = dayStart.getTime();
  const sinceSec = Math.floor(sinceMs / 1000);

  const { insertLead, getCache, putCache } = initDb("leads.db");
  const llm = DRY_RUN ? null : createLlm(cfg.openai, cfg.llmConcurrency);
  const client = await createClient(cfg.tg);

  // лимитеры для экономии
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

  const chatCache = new Map();

  const stats = {
    rangeLabel: "today-start",
    sinceIso: new Date(sinceMs).toISOString(),
    DRY_RUN,
    SOFT_MODE,
    dialogsTotal: 0,
    dialogsEligible: 0,
    dialogsSkippedPrivate: 0,
    chatsScanned: 0,
    msgsRead: 0,
    msgsInWindow: 0,
    msgsText: 0,
    msgsPassedFilters: 0,
    msgsSkippedUkrainian: 0,
    llmCalls: 0,
    llmCacheHits: 0,
    llmRateSkipped: 0,
    leads: 0,
    sendOk: false,
    sendErr: null,
  };

  let buffer = [];
  let sentLeadsCursor = 0;

  async function sendPartialDigest(reason) {
    if (DRY_RUN) return;
    if (sentLeadsCursor >= buffer.length) return;
    while (sentLeadsCursor < buffer.length) {
      const part = buffer.slice(
        sentLeadsCursor,
        sentLeadsCursor + bf.partialBatchSize,
      );
      const lines = part.map((x, i) => {
        const preview = (x.text || "")
          .replace(/\s+/g, " ")
          .slice(0, bf.partialPreviewChars);
        return `${i + 1}) [${x.chatTitle}] score=${x.score} cat=${x.category}
${preview}
DM1: ${x.dm1 || "-"}
DM2: ${x.dm2 || "-"}
${x.link}`;
      });

      const payload = `🧲 Backfill partial (${reason})
newLeads=${part.length} totalLeads=${stats.leads}

${lines.join("\n\n")}`;
      try {
        await client.sendMessage("me", { message: payload });
        sentLeadsCursor += part.length;
        stats.sendOk = true;
      } catch (e) {
        stats.sendErr = String(e?.message || e);
        console.error("Partial send failed:", stats.sendErr);
        break;
      }
    }
  }

  const rawDialogs = await client.getDialogs({ limit: dialogsLimit });
  const dialogs = [...rawDialogs].sort(
    (a, b) => dialogActivitySec(b) - dialogActivitySec(a),
  );
  stats.dialogsTotal = dialogs.length;

  console.log(
    `[backfill] scanning ${stats.dialogsTotal} dialogs (sorted by last activity), since=${stats.sinceIso}, maxLeads=${maxLeads}`,
  );

  // основной проход
  for (let i = 0; i < dialogs.length; i++) {
    const d = dialogs[i];
    const entity = d.entity; // Chat/Channel/User
    const peer = d.inputEntity || d.entity; // InputPeer* для iterMessages

    if (entity?.className === "User") {
      stats.dialogsSkippedPrivate++;
      continue;
    }

    // ❌ лички исключаем (и вообще всё, что не группа/канал)
    if (
      !shouldScanChatEntity(entity, {
        scanGroups: cfg.scanGroups,
        scanChannels: cfg.scanChannels,
      })
    ) {
      continue;
    }

    stats.dialogsEligible++;

    const chatInfo = await resolveChatInfo(entity, chatCache);
    const lastActivitySec = dialogActivitySec(d);
    const activityIso = lastActivitySec
      ? new Date(lastActivitySec * 1000).toISOString()
      : "unknown";
    console.log(
      `[backfill] chat ${i + 1}/${dialogs.length} ${chatInfo.title} (${chatInfo.className || "?"}) activity=${activityIso}`,
    );

    let processedThisChat = 0;

    // читаем сообщения (newest -> oldest)
    for await (const msg of client.iterMessages(peer, {
      limit: perChatLimit,
    })) {
      processedThisChat++;
      stats.msgsRead++;

      if (
        perMessagesPauseEvery > 0 &&
        perMessagesPauseMs > 0 &&
        processedThisChat % perMessagesPauseEvery === 0
      ) {
        await sleep(perMessagesPauseMs);
      }

      const msgSec = msgDateSec(msg);

      // если дата определилась и ушли за окно — стоп по этому чату
      if (msgSec != null && msgSec < sinceSec) break;

      // если дату не смогли определить — всё равно считаем как “внутри”, чтобы не потерять
      if (msgSec == null || msgSec >= sinceSec) stats.msgsInWindow++;

      const text = msg.message || "";
      if (!text) continue;
      stats.msgsText++;

      // фильтры
      if (!SOFT_MODE) {
        if (!cfg.disablePrefilter && !prefilter(text)) continue;
        if (cfg.rejectPromoOrBot && looksLikePromoOrBot(text)) continue;
        if (cfg.rejectUkrainian && looksLikeUkrainian(text)) {
          stats.msgsSkippedUkrainian++;
          continue;
        }
        if (cfg.requireQuestionOrClaim && !looksLikeQuestionOrClaim(text))
          continue;
      } else {
        if (text.trim().length < 8) continue;
      }

      stats.msgsPassedFilters++;

      if (DRY_RUN) continue;

      const msgId = msg.id;
      const link = buildLink({
        username: chatInfo.username,
        chatId: chatInfo.id,
        msgId,
      });

      // sender
      const sender = await msg.getSender().catch(() => null);
      if (isSelfChannelPost(msg, sender, entity)) continue;
      const senderId = sender?.id ? normId(sender.id) : null;

      // rate-limits
      if (
        !allowGlobal() ||
        !allowForChat(chatInfo.id) ||
        !allowForUser(senderId)
      ) {
        stats.llmRateSkipped++;
        continue;
      }

      // cache
      const cached = getCache.get(chatInfo.id, msgId, cfg.openai.model);
      let llmRes;
      if (cached?.result_json) {
        llmRes = JSON.parse(cached.result_json);
        stats.llmCacheHits++;
      } else {
        llmRes = await llm.classifyLead({ chatTitle: chatInfo.title, text });
        putCache.run(
          chatInfo.id,
          msgId,
          cfg.openai.model,
          JSON.stringify(llmRes),
          Math.floor(Date.now() / 1000),
        );
        stats.llmCalls++;
      }

      if (!llmRes.lead) continue;
      if ((llmRes.score ?? 0) < cfg.leadScoreMin) continue;

      insertLead.run({
        chat_id: chatInfo.id,
        msg_id: msgId,
        sender_id: senderId,
        date: msgSec,
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

      buffer.push({
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

      if (
        partialDigestEveryLeads > 0 &&
        stats.leads % partialDigestEveryLeads === 0
      ) {
        await sendPartialDigest(`every ${partialDigestEveryLeads} leads`);
      }

      // чтобы не было гигантского результата
      if (buffer.length >= bf.bufferCap) break;

      if (maxLeads > 0 && stats.leads >= maxLeads) break;

    }

    if (processedThisChat > 0) stats.chatsScanned++;

    if (stats.chatsScanned > 0 && stats.chatsScanned % progressEveryChats === 0) {
      console.log(
        `[backfill] progress chatsScanned=${stats.chatsScanned} leads=${stats.leads} msgsRead=${stats.msgsRead}`,
      );
      await sendPartialDigest(`progress@chat=${stats.chatsScanned}`);
    }

    // пауза между чатами
    if (perChatDelayMs > 0) await sleep(perChatDelayMs);

    // если уже набрали достаточно лидов — можно закончить раньше
    if (maxLeads > 0 && stats.leads >= maxLeads) break;
  }

  // --- сообщение в Saved Messages ---
  await sendPartialDigest("final-flush");

  const top = buffer.sort((a, b) => b.score - a.score).slice(0, bf.finalTopLimit);
  const lines = top.map((x, i) => {
    const preview = (x.text || "")
      .replace(/\s+/g, " ")
      .slice(0, bf.finalPreviewChars);
    return `${i + 1}) [${x.chatTitle}] score=${x.score} cat=${x.category}
${preview}
DM1: ${x.dm1 || "-"}
DM2: ${x.dm2 || "-"}
${x.link}
`;
  });

  const report = `🧲 Backfill report (${stats.rangeLabel})
since: ${stats.sinceIso}
DRY_RUN=${stats.DRY_RUN ? 1 : 0} SOFT_MODE=${stats.SOFT_MODE ? 1 : 0}

dialogsTotal=${stats.dialogsTotal}
dialogsEligible(groups/channels)=${stats.dialogsEligible}
dialogsSkippedPrivate=${stats.dialogsSkippedPrivate}
chatsScanned=${stats.chatsScanned}

msgsRead=${stats.msgsRead}
msgsInWindow=${stats.msgsInWindow}
msgsText=${stats.msgsText}
msgsPassedFilters=${stats.msgsPassedFilters}
msgsSkippedUkrainian=${stats.msgsSkippedUkrainian}

llmCalls=${stats.llmCalls}
llmCacheHits=${stats.llmCacheHits}
llmRateSkipped=${stats.llmRateSkipped}

leads=${stats.leads}

TOP:
${lines.length ? "(already sent via partial chunks)" : "(no leads found)"}`;

  try {
    await client.sendMessage("me", { message: report });
    stats.sendOk = true;
  } catch (e) {
    stats.sendErr = String(e?.message || e);
    console.error("Send to Saved Messages failed:", stats.sendErr);
  }

  console.log("✅ Backfill finished. sendOk=", stats.sendOk);
  process.exit(0);
})();
