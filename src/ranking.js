function clampInt(n, min, max) {
  const x = Number(n);
  if (Number.isNaN(x)) return min;
  return Math.max(min, Math.min(max, Math.round(x)));
}

function normalizeLeadArchetype(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "1.1") return "1.1";
  if (v === "1.2") return "1.2";
  return "other";
}

function computePriority(llmRes) {
  const score = clampInt(llmRes?.score, 0, 100);
  const outreachFit = clampInt(llmRes?.outreach_fit, 0, 100);
  const painLevel = clampInt(llmRes?.pain_level, 0, 100);
  const leadArchetype = normalizeLeadArchetype(llmRes?.lead_archetype);

  // Смещаем в пользу типа 1.1 (проблема/боль), чтобы он шёл выше в дайджесте.
  const archetypeBoost = leadArchetype === "1.1" ? 35 : leadArchetype === "1.2" ? -25 : 0;
  const priorityScore = clampInt(
    score + archetypeBoost + painLevel * 0.35 + outreachFit * 0.15,
    0,
    200,
  );

  return {
    score,
    outreachFit,
    painLevel,
    leadArchetype,
    priorityScore,
  };
}

module.exports = {
  computePriority,
  normalizeLeadArchetype,
};
