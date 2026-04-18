// 默认配置
const defaults = {
  password: "TestPass123!",
  gmail: {
    user: "",
    appPassword: "",
  },
  delay: 5000,
  maxRetries: 2,          // 每个注册失败后重试次数
  maxConcurrentRequests: 1,
  verificationTimeout: 300000,
  pageTimeout: 30000,
  headless: false,
  defaultReferralCode: "",
  nicknamePrefix: "user",
  baseUrl: "https://world.nol.com/zh-CN/auth-web/email-registration",
};

// 尝试加载本地配置（不进 git）
let local = {};
try {
  local = require('./config.local');
} catch {}

// 合并：本地配置覆盖默认值
const config = { ...defaults, ...local };
if (local.gmail) {
  config.gmail = { ...defaults.gmail, ...local.gmail };
}

module.exports = config;
