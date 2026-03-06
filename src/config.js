require("dotenv").config();

function b(name, def = false) {
  const v = process.env[name];
  if (v == null) return def;
  return String(v) === "1" || String(v).toLowerCase() === "true";
}

function n(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : def;
}

function i(name, def, min = 0) {
  const v = n(name, def);
  return Math.max(min, Math.floor(v));
}

function pickByAccount(baseName, account) {
  if (!account) return process.env[baseName];
  const accKey = `${baseName}_${account}`;
  return process.env[accKey] ?? process.env[baseName];
}

const tgAccountRaw = process.env.TG_ACCOUNT;
const tgAccount =
  tgAccountRaw != null && String(tgAccountRaw).trim() !== ""
    ? String(tgAccountRaw).trim()
    : null;

module.exports = {
  tg: {
    account: tgAccount || "default",
    apiId: Number(pickByAccount("TG_API_ID", tgAccount)) || 0,
    apiHash: pickByAccount("TG_API_HASH", tgAccount),
    phone: pickByAccount("TG_PHONE", tgAccount),
    session: pickByAccount("TG_SESSION", tgAccount),
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
  },

  llmConcurrency: i("LLM_CONCURRENCY", 2, 1),
  scanHeartbeatSec: i("SCAN_HEARTBEAT_SEC", 60, 5),
  scanIncomingOnly: b("SCAN_INCOMING_ONLY", true),
  scanCatchupEnabled: b("SCAN_CATCHUP_ENABLED", true),
  scanCatchupEverySec: i("SCAN_CATCHUP_EVERY_SEC", 300, 30),
  scanCatchupLookbackMin: i("SCAN_CATCHUP_LOOKBACK_MIN", 20, 1),
  scanCatchupDialogsLimit: i("SCAN_CATCHUP_DIALOGS_LIMIT", 80, 1),
  scanCatchupDialogsPoolLimit: i("SCAN_CATCHUP_DIALOGS_POOL_LIMIT", 300, 1),
  scanCatchupRotateDialogs: b("SCAN_CATCHUP_ROTATE_DIALOGS", true),
  scanCatchupPerChatLimit: i("SCAN_CATCHUP_PER_CHAT_LIMIT", 120, 1),
  scanCatchupChatDelayMs: i("SCAN_CATCHUP_CHAT_DELAY_MS", 150, 0),
  scanCatchupMsgPauseEvery: i("SCAN_CATCHUP_MSG_PAUSE_EVERY", 50, 0),
  scanCatchupMsgPauseMs: i("SCAN_CATCHUP_MSG_PAUSE_MS", 120, 0),
  scanCatchupMaxRuntimeSec: i("SCAN_CATCHUP_MAX_RUNTIME_SEC", 0, 0),
  digestEverySec: n("DIGEST_EVERY_SEC", 180),
  digestFlushEveryLeads: i("DIGEST_FLUSH_EVERY_LEADS", 5, 1),
  digestMaxItemsPerMessage: i("DIGEST_MAX_ITEMS_PER_MESSAGE", 5, 1),
  digestTopLimit: i("DIGEST_TOP_LIMIT", 15, 1),
  digestPreviewChars: i("DIGEST_PREVIEW_CHARS", 180, 40),
  leadScoreMin: n("LEAD_SCORE_MIN", 75),

  // rate limits (экономия)
  maxLlmPerMin: i("MAX_LLM_PER_MIN", 60, 1),
  maxLlmPerChatPerMin: i("MAX_LLM_PER_CHAT_PER_MIN", 10, 1),
  maxLlmPerUserPerMin: i("MAX_LLM_PER_USER_PER_MIN", 4, 1),

  // режимы
  debug: b("DEBUG", false),
  disablePrefilter: b("DISABLE_PREFILTER", false),
  rejectPromoOrBot: b("REJECT_PROMO_OR_BOT", true),
  rejectBuySellOffers: b("REJECT_BUY_SELL_OFFERS", true),
  rejectUkrainian: b("REJECT_UKRAINIAN", true),
  requireQuestionOrClaim: b("REQUIRE_QUESTION_OR_CLAIM", true),

  // что сканить
  // private всегда выключены, а вот каналы можно включать/выключать:
  scanChannels: b("SCAN_CHANNELS", true), // каналы/супергруппы (Channel)
  scanGroups: b("SCAN_GROUPS", true), // обычные группы (Chat)

  backfill: {
    dialogsLimit: i("BACKFILL_DIALOGS_LIMIT", 250, 1),
    perChatLimit: i("BACKFILL_PER_CHAT_LIMIT", 1200, 1),
    maxLeads: i("BACKFILL_MAX_LEADS", 25, 1),
    chatDelayMs: i("BACKFILL_CHAT_DELAY_MS", 550, 0),
    msgPauseEvery: i("BACKFILL_MSG_PAUSE_EVERY", 40, 0),
    msgPauseMs: i("BACKFILL_MSG_PAUSE_MS", 180, 0),
    progressEveryChats: i("BACKFILL_PROGRESS_EVERY_CHATS", 5, 1),
    partialDigestEveryLeads: i("BACKFILL_PARTIAL_DIGEST_EVERY", 5, 0),
    partialBatchSize: i("BACKFILL_PARTIAL_BATCH_SIZE", 5, 1),
    partialPreviewChars: i("BACKFILL_PARTIAL_PREVIEW_CHARS", 140, 40),
    finalTopLimit: i("BACKFILL_FINAL_TOP_LIMIT", 15, 1),
    finalPreviewChars: i("BACKFILL_FINAL_PREVIEW_CHARS", 160, 40),
    bufferCap: i("BACKFILL_BUFFER_CAP", 120, 10),
    dryRun: b("DRY_RUN", false),
    softMode: b("SOFT_MODE", false),
  },
};
