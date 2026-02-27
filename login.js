const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input"); // npm i input
const cfg = require("./src/config.js");

const apiId = cfg.tg.apiId;
const apiHash = cfg.tg.apiHash;
const account = cfg.tg.account || "default";
const stringSession = new StringSession(""); // fill this later with the value from session.save()

if (!apiId || !apiHash) {
  throw new Error(
    "TG API credentials missing. Set TG_ACCOUNT and TG_API_ID_<N>/TG_API_HASH_<N> (or fallback TG_API_ID/TG_API_HASH).",
  );
}

(async () => {
  console.log(`Loading interactive login for TG account=${account}...`);
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  client.setLogLevel("debug");

  await client.start({
    phoneNumber: async () => {
      if (cfg.tg.phone) return cfg.tg.phone;
      return input.text("number ?");
    },
    password: async () => await input.text("password?"),
    phoneCode: async () => await input.text("Code ?"),
    onError: (err) => console.log(err),
  });
  console.log("You should now be connected.");
  const session = client.session.save();
  console.log(session); // Save this string to avoid logging in again
  console.log(
    `Put this into .env as TG_SESSION_${account}=<session> (or TG_SESSION=<session> for default).`,
  );
  await client.sendMessage("me", { message: "Hello!" });
})();
