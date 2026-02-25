const Database = require("better-sqlite3");

function initDb(filename = "leads.db") {
  const db = new Database(filename);

  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      chat_id TEXT NOT NULL,
      msg_id INTEGER NOT NULL,
      sender_id TEXT,
      date INTEGER,
      chat_title TEXT,
      chat_username TEXT,
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
      chat_id,msg_id,sender_id,date,chat_title,chat_username,text,link,llm_score,category,angle,dm1,dm2,why,created_at
    ) VALUES (
      @chat_id,@msg_id,@sender_id,@date,@chat_title,@chat_username,@text,@link,@llm_score,@category,@angle,@dm1,@dm2,@why,@created_at
    )
  `);

  const getCache = db.prepare(
    `SELECT result_json FROM llm_cache WHERE chat_id=? AND msg_id=? AND model=?`,
  );
  const putCache = db.prepare(
    `INSERT OR REPLACE INTO llm_cache(chat_id,msg_id,model,result_json,created_at) VALUES(?,?,?,?,?)`,
  );

  return { db, insertLead, getCache, putCache };
}

module.exports = { initDb };
