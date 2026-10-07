// Tells the web page where its database is. Only the public (browser-safe) key is sent.
const { env, send } = require("../lib/server");

module.exports = (req, res) => {
  const e = env();
  send(res, 200, {
    supabaseUrl: e.url,
    supabaseKey: e.publicKey,
    emailReady: !!(e.resendKey && e.emailFrom),
    usersReady: !!e.secretKey
  });
};
