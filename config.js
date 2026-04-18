const defaults = {
  password: "TestPass123!",
  gmail: { user: "", appPassword: "" },
  delay: 5000,
  maxRetries: 2,
  maxConcurrentRequests: 1,
  verificationTimeout: 300000,
  pageTimeout: 30000,
  headless: false,
  defaultReferralCode: "",
  nicknamePrefix: "user",
  baseUrl: "https://world.nol.com/zh-CN/auth-web/email-registration",
};

let local = {};
try { local = require('./config.local'); } catch {}

const config = { ...defaults, ...local };
if (local.gmail) { config.gmail = { ...defaults.gmail, ...local.gmail }; }

module.exports = config;
