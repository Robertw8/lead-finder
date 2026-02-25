const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

function normId(id) {
  if (id == null) return null;
  const v = id.value ?? id;
  return typeof v === "bigint" ? v.toString() : String(v);
}

function buildLink({ username, chatId, msgId }) {
  if (username) return `https://t.me/${username}/${msgId}`;
  const absId = Math.abs(Number(chatId));
  const internal =
    absId > 1_000_000_000_000 ? absId - 1_000_000_000_000 : absId;
  return `https://t.me/c/${internal}/${msgId}`;
}

async function createClient({ apiId, apiHash, session }) {
  const client = new TelegramClient(
    new StringSession(session),
    apiId,
    apiHash,
    { connectionRetries: 5 },
  );
  await client.connect();
  return client;
}

async function resolveChatInfo(chatEntity, cache) {
  const id = normId(chatEntity.id);
  if (cache.has(id)) return cache.get(id);

  const username = chatEntity.username || null;
  const title =
    chatEntity.title || chatEntity.firstName || chatEntity.username || id;

  const info = { id, username, title, className: chatEntity.className };
  cache.set(id, info);
  return info;
}

module.exports = { normId, buildLink, createClient, resolveChatInfo };
