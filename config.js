module.exports = {
  // ============== 注册密码 ==============
  password: "TestPass123!",

  // ============== Gmail 配置 ==============
  gmail: {
    user: process.env.GMAIL_USER || "",
    appPassword: process.env.GMAIL_APP_PASSWORD || "",
  },

  // ============== 通用配置 ==============
  delay: 5000,
  maxConcurrentRequests: 1,
  verificationTimeout: 300000,
  pageTimeout: 30000,
  headless: false,
  defaultReferralCode: "",
  nicknamePrefix: "user",
  baseUrl: "https://world.nol.com/zh-CN/auth-web/email-registration",
};
