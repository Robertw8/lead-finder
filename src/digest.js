function createDigest(
  {
    everySec,
    topLimit = 15,
    previewChars = 180,
    flushEveryLeads = 5,
    maxItemsPerMessage = 5,
  },
  sendFn,
) {
  let buffer = [];
  const MAX_TELEGRAM_MSG_CHARS = 3500;
  let flushing = false;

  function add(item) {
    buffer.push(item);
    if (flushEveryLeads > 0 && buffer.length >= flushEveryLeads) {
      flush().catch((e) =>
        console.error("digest flush error:", String(e?.message || e)),
      );
    }
  }

  async function flush() {
    if (flushing) return;
    if (!buffer.length) return;
    flushing = true;

    try {
      const top = buffer
        .sort((a, b) => {
          const pa = Number(a.priorityScore ?? a.score ?? 0);
          const pb = Number(b.priorityScore ?? b.score ?? 0);
          if (pb !== pa) return pb - pa;
          return Number(b.score ?? 0) - Number(a.score ?? 0);
        })
        .slice(0, topLimit);

      const lines = top.map((x, i) => {
        const preview = (x.text || "").replace(/\s+/g, " ").slice(0, previewChars);
        return `${i + 1}) [${x.chatTitle}] pri=${x.priorityScore ?? x.score} score=${x.score} cat=${x.category} type=${x.leadArchetype || "other"} pain=${x.painLevel ?? 0}
${preview}
${x.link}
`;
      });

      const itemChunks = [];
      for (let i = 0; i < lines.length; i += maxItemsPerMessage) {
        itemChunks.push(lines.slice(i, i + maxItemsPerMessage));
      }

      const chunks = [];
      for (const itemChunk of itemChunks) {
        let chunk = `🧲 Leads (${top.length})\n\n`;
        for (const line of itemChunk) {
          const piece = line + "\n";
          if (chunk.length + piece.length > MAX_TELEGRAM_MSG_CHARS) {
            chunks.push(chunk.trimEnd());
            chunk = piece;
          } else {
            chunk += piece;
          }
        }
        if (chunk.trim()) chunks.push(chunk.trimEnd());
      }

      for (let i = 0; i < chunks.length; i++) {
        const body =
          chunks.length === 1
            ? chunks[i]
            : `🧲 Leads (${top.length}) part ${i + 1}/${chunks.length}\n\n${chunks[i]}`;
        await sendFn(body);
      }

      buffer = [];
    } finally {
      flushing = false;
    }
  }

  setInterval(() => {
    flush().catch((e) =>
      console.error("digest flush error:", String(e?.message || e)),
    );
  }, everySec * 1000);

  return { add, flush };
}

module.exports = { createDigest };
