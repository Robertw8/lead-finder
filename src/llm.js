const OpenAI = require("openai");
const pLimit = require("p-limit").default;
const { normalizeLeadArchetype } = require("./ranking.js");

function clampInt(n, min, max) {
  const x = Number(n);
  if (Number.isNaN(x)) return min;
  return Math.max(min, Math.min(max, Math.round(x)));
}

function createLlm({ apiKey, model }, concurrency = 2) {
  const openai = new OpenAI({ apiKey });
  const limit = pLimit(concurrency);

  async function classifyLead({ chatTitle, text }) {
    const prompt = `
Ты строгий фильтр лидов в крипто-чате. Нужны сообщения, которые с высокой вероятностью написаны ЖИВЫМ человеком и дают естественный повод написать в личку.

lead=true ТОЛЬКО если есть хотя бы одно:
- конкретный вопрос/непонимание/просьба;
- конкретная проблема/ошибка/страх/жалоба;
- личный опыт/история/ситуация (не абстрактно);
- спор/несогласие/позиция, которую можно обсудить;
- конкретное утверждение с деталями (цифры/биржа/кошелёк/сделка/стратегия).

lead=false если:
- похоже на бот/копипасту/маркетинговый пост;
- “ура рынок”, общие эмоции без сути, много эмодзи;
- реклама, рефки, сигналы;
- бессодержательно.

Верни ТОЛЬКО JSON:
{
  "lead": true|false,
  "score": 0-100,
  "category": "question|problem|opinion|debate|story|fear|brag|scam|other",
  "lead_archetype": "1.1|1.2|other",
  "pain_level": 0-100,
  "is_question": true|false,
  "sweet_question": true|false,
  "outreach_fit": 0-100,
  "angle": "как зайти в личку (1-2 предложения, конкретно)",
  "why": "почему это лид/не лид (1 предложение)"
}

Где:
- lead_archetype="1.1" если человек в проблеме/боли/растерянности (например потеря депозита, не понимает как заработать, просит помощи);
- lead_archetype="1.2" если человек опытный, давно в крипте, выглядит спокойным и без явной проблемы;
- lead_archetype="other" во всех остальных случаях.
- pain_level оценивает силу боли/срочности: 0=боли нет, 100=очень сильная боль/отчаяние.

Чат: ${chatTitle}
Сообщение: """${text}"""
`;

    const resp = await openai.responses.create({
      model,
      input: prompt,
      max_output_tokens: 220,
    });

    const out = (resp.output_text || "").trim();
    const a = out.indexOf("{");
    const b = out.lastIndexOf("}");
    if (a === -1 || b === -1) throw new Error("LLM output has no JSON");

    const data = JSON.parse(out.slice(a, b + 1));
    data.lead = !!data.lead;
    data.score = clampInt(data.score, 0, 100);
    data.category = String(data.category || "other");
    data.lead_archetype = normalizeLeadArchetype(data.lead_archetype);
    data.pain_level = clampInt(data.pain_level, 0, 100);
    data.is_question = !!data.is_question;
    data.sweet_question = !!data.sweet_question;
    data.outreach_fit = clampInt(data.outreach_fit, 0, 100);
    data.angle = String(data.angle || "");
    data.why = String(data.why || "");
    const drafts = Array.isArray(data.dm_drafts) ? data.dm_drafts : [];
    data.dm_drafts = [
      String(drafts[0] || "").slice(0, 220),
      String(drafts[1] || "").slice(0, 220),
    ];
    return data;
  }

  return {
    classifyLead: (args) => limit(() => classifyLead(args)),
  };
}

module.exports = { createLlm };
