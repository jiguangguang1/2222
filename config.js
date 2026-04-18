module.exports = {
  // 注册使用的密码（8+位，需包含英文、数字、特殊符号中至少两种）
  password: "TestPass123!",
  
  // 每批次处理间隔（毫秒）
  delay: 5000,
  
  // 每批次并发数量（手动模式生效，全自动模式为串行）
  maxConcurrentRequests: 1,
  
  // 邮箱验证码等待超时（毫秒），默认5分钟（全自动模式生效）
  verificationTimeout: 300000,
  
  // 页面加载超时（毫秒）
  pageTimeout: 30000,
  
  // 是否使用无头模式（true=后台运行, false=显示浏览器）
  headless: false,
  
  // 邀请码（可选，留空则启动时手动输入）
  defaultReferralCode: "",
  
  // 昵称前缀（实际昵称 = prefix + 随机数）
  nicknamePrefix: "user",
  
  // 注册页面URL
  baseUrl: "https://world.nol.com/zh-CN/auth-web/email-registration",
};
