function prefilter(text) {
  if (!text) return false;
  const t = text.trim();
  const low = t.toLowerCase();

  // Разрешаем короткие тикерные сообщения и короткие запросы на разбор.
  if (t.length < 12) {
    const compact = t.replace(/\s+/g, "");
    const tickerOnly = /^[A-Za-z]{2,6}$/.test(compact);
    const coinWithPair =
      /^(btc|eth|sol|bnb|xrp|ada|doge|dot|trx|ltc|avax|matic|ton|link|uni|atom)(usdt|usd|btc|eth)?$/i.test(
        compact,
      );
    const shortAsk = /\b(разбор|мнение|идея|сетап|вход)\b/i.test(low);
    if (!(tickerOnly || coinWithPair || shortAsk)) return false;
  }

  // реклама/рефки
  if (/(airdrop|giveaway|promo|промо|реф|ref|bit\.ly|tinyurl)/.test(low))
    return false;

  // односложные
  if (/^(gm|gn|лол|ок|ага|да|нет|\+\+|👍|🔥)$/i.test(t)) return false;

  // много ссылок
  const urlCount = (t.match(/https?:\/\/|t\.me\//g) || []).length;
  if (urlCount >= 2) return false;

  return true;
}

function looksLikeQuestionOrClaim(text) {
  if (!text) return false;
  const t = text.trim();
  const low = t.toLowerCase();
  const compact = t.replace(/\s+/g, "");

  // Однословные тикеры типа "SOL", "BTC", "ETH" считаем сигналом интереса.
  if (
    /^[A-Za-z]{2,6}$/.test(compact) ||
    /^(btc|eth|sol|bnb|xrp|ada|doge|dot|trx|ltc|avax|matic|ton|link|uni|atom)(usdt|usd|btc|eth)?$/i.test(
      compact,
    )
  ) {
    return true;
  }

  if (t.length < 8) return false;

  if (/\?/.test(t)) return true;
  if (/\b(как|почему|зачем|когда|где|кто|что|какой|какая|какие)\b/i.test(low))
    return true;

  // Явные просьбы / запросы на разбор.
  if (
    /\b(подскажите|посоветуйте|помогите|нужен|нужна|нужно|разбор|разберите|мнение|оцените|что\s+по|кто\s+смотрел|взгляд\s+на|идея\s+по|сетап)\b/i.test(
      low,
    )
  )
    return true;

  if (
    /\b(я думаю|я считаю|мне кажется|по-моему|считаю что|думаю что|я не понимаю|я купил|я продал|у меня|моя позиция)\b/i.test(
      low,
    )
  )
    return true;

  if (/\b(это скам|не скам|это ошибка|это бред|рынок пойдет|цена будет)\b/i.test(low))
    return true;

  // лёгкое расширение: нейтральные тезисы/наблюдения
  if (
    /\b(кажется|похоже|по факту|на мой взгляд|по моему опыту|в итоге|получается|вышло так)\b/i.test(
      low,
    )
  )
    return true;

  return false;
}

function looksLikePromoOrBot(text) {
  const t = text.trim();
  const low = t.toLowerCase();

  // эмодзи перебор
  const emojiCount = (t.match(/[\u{1F300}-\u{1FAFF}]/gu) || []).length;
  if (emojiCount >= 6) return true;

  // восклицания
  const ex = (t.match(/!/g) || []).length;
  if (ex >= 3) return true;

  // капс
  const letters = (t.match(/[A-Za-zА-Яа-я]/g) || []).length;
  const upper = (t.match(/[A-ZА-Я]/g) || []).length;
  if (letters >= 20 && upper / letters > 0.6) return true;

  // “ура рынок” шаблоны (как на твоём скрине)
  if (
    /(btc.*рекорд|альткоины.*мчатся|все кто вложился|только вверх|не финансовый совет|to the moon)/.test(
      low,
    )
  )
    return true;

  // шаблонные “форумные”/сигнальные посты (не живой диалог)
  if (
    /(валютная пара|котировка открытия|котировка закрытия|разница пунктов|подготовьте перекрытие|otc\s+подготовьте перекрытие)/.test(
      low,
    )
  )
    return true;

  // много структурных полей вида "метка: значение" — признак шаблонного поста
  const labelFields = (low.match(/[:：]/g) || []).length;
  if (labelFields >= 3 && /(пара|котировка|пункт|сигнал|вход|выход)/.test(low))
    return true;

  return false;
}

function looksLikeBuySellOffer(text) {
  if (!text) return false;
  const low = text.toLowerCase();

  // Явные формулировки торгового оффера.
  if (
    /\b(куплю|продам|покупаю|продаю|buying|selling|wtb|wts)\b/i.test(low)
  ) {
    return true;
  }

  // Англ. buy/sell + маркеры p2p/otc/прямого контакта.
  if (
    /\b(buy|sell)\b/i.test(low) &&
    /\b(otc|p2p|usdt|dm|pm|в\s*лс|в\s*личку|личк[ауе]|пишите)\b/i.test(low)
  ) {
    return true;
  }

  // Частые русские офферы обмена/сделки.
  if (
    /\b(обменяю|обмен|сделка|купля|продажа)\b/i.test(low) &&
    /\b(в\s*лс|в\s*личку|пишите|срочно|otc|p2p)\b/i.test(low)
  ) {
    return true;
  }

  return false;
}

function looksLikeUkrainian(text) {
  if (!text) return false;
  const low = text.toLowerCase();

  // Буквы, которые характерны для украинского и отсутствуют в русском.
  if (/[іїєґ]/.test(low)) return true;

  // Дополнительная эвристика по частым украинским словам.
  const uaWordHits = (
    low.match(
      /\b(це|що|який|яка|які|мене|тобі|вам|також|будь|ласка|для|після|сьогодні|зараз|коли|чому|якщо|щоб|тільки|привіт)\b/g,
    ) || []
  ).length;

  return uaWordHits >= 2;
}

// type guard: private messages НЕ сканим
// В GramJS chat entity бывает: User (личка), Chat (группа), Channel (канал/супергруппа)
function shouldScanChatEntity(entity, { scanGroups, scanChannels }) {
  const cls = entity?.className; // "User" | "Chat" | "Channel" | ...
  if (!cls) return false;

  if (cls === "User") return false; // ❌ личка
  if (cls === "Chat") return !!scanGroups; // ✅ обычная группа
  if (cls === "Channel") {
    // broadcast-каналы (посты) исключаем, нужны чаты/комментарии
    if (entity?.broadcast === true) return false;
    return !!scanChannels; // ✅ супергруппа/дискуссия
  }
  return false;
}

function idAsString(id) {
  if (id == null) return null;
  const v = id.value ?? id;
  return typeof v === "bigint" ? v.toString() : String(v);
}

function isSelfChannelPost(msg, sender, chatEntity) {
  if (!msg || !chatEntity) return false;

  if (msg.post === true) return true;
  if (msg.postAuthor) return true;

  const chatId = idAsString(chatEntity.id);
  const senderId = idAsString(sender?.id);
  if (chatId && senderId && chatId === senderId) return true;

  const fromId = msg.fromId;
  if (fromId?.className === "PeerChannel") {
    const fromChannelId = idAsString(fromId.channelId);
    if (fromChannelId && chatId && fromChannelId === chatId) return true;
  }

  return false;
}

module.exports = {
  prefilter,
  looksLikePromoOrBot,
  looksLikeBuySellOffer,
  looksLikeQuestionOrClaim,
  looksLikeUkrainian,
  shouldScanChatEntity,
  isSelfChannelPost,
};
