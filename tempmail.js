/**
 * 临时邮箱模块 - 使用 mail.tm API
 * 自动创建临时邮箱、等待验证码、提取6位数字
 */

const axios = require('axios');

const API_BASE = 'https://api.mail.tm';

class TempMail {
  constructor() {
    this.token = null;
    this.accountId = null;
    this.email = null;
    this.password = null;
    this.domain = null;
  }

  // ========================
  // 初始化：获取可用域名
  // ========================
  async init() {
    try {
      const res = await axios.get(`${API_BASE}/domains`);
      const domains = res.data['hydra:member'];
      const active = domains.find(d => d.isActive && !d.isPrivate);
      if (!active) throw new Error('没有可用的临时邮箱域名');
      this.domain = active.domain;
      return this.domain;
    } catch (err) {
      throw new Error(`获取域名失败: ${err.message}`);
    }
  }

  // ========================
  // 创建临时邮箱账户
  // ========================
  async createAccount(namePrefix = 'user') {
    if (!this.domain) await this.init();

    // 生成随机用户名，避免重复
    const rand = Math.random().toString(36).substring(2, 10);
    const address = `${namePrefix}_${rand}@${this.domain}`;
    const password = `P@ss${rand}!`;

    try {
      const res = await axios.post(`${API_BASE}/accounts`, {
        address,
        password,
      });

      this.accountId = res.data.id;
      this.email = res.data.address;
      this.password = password;

      // 登录获取 token
      await this.login();

      return this.email;
    } catch (err) {
      const msg = err.response?.data?.['hydra:description'] || err.message;
      throw new Error(`创建邮箱失败: ${msg}`);
    }
  }

  // ========================
  // 登录获取 Bearer Token
  // ========================
  async login() {
    try {
      const res = await axios.post(`${API_BASE}/token`, {
        address: this.email,
        password: this.password,
      });
      this.token = res.data.token;
      return this.token;
    } catch (err) {
      throw new Error(`登录邮箱失败: ${err.message}`);
    }
  }

  // ========================
  // 获取邮件列表
  // ========================
  async getMessages() {
    if (!this.token) throw new Error('未登录');

    try {
      const res = await axios.get(`${API_BASE}/messages`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      return res.data['hydra:member'];
    } catch (err) {
      // token 过期则重新登录
      if (err.response?.status === 401) {
        await this.login();
        return this.getMessages();
      }
      throw new Error(`获取邮件失败: ${err.message}`);
    }
  }

  // ========================
  // 获取单封邮件详情
  // ========================
  async getMessage(messageId) {
    if (!this.token) throw new Error('未登录');

    try {
      const res = await axios.get(`${API_BASE}/messages/${messageId}`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      return res.data;
    } catch (err) {
      if (err.response?.status === 401) {
        await this.login();
        return this.getMessage(messageId);
      }
      throw new Error(`获取邮件详情失败: ${err.message}`);
    }
  }

  // ========================
  // 等待验证码邮件，自动提取6位数字
  // ========================
  // timeout: 超时时间（毫秒）
  // interval: 轮询间隔（毫秒）
  async waitForVerificationCode(timeout = 300000, interval = 5000) {
    const startTime = Date.now();
    let lastMsgCount = 0;

    console.log(`📧 临时邮箱已创建: ${this.email}`);
    console.log(`⏳ 等待验证码邮件... (超时: ${timeout / 1000}s)`);

    while (Date.now() - startTime < timeout) {
      try {
        const messages = await this.getMessages();

        // 有新邮件到达
        if (messages.length > lastMsgCount) {
          console.log(`📬 收到 ${messages.length} 封邮件`);

          // 从最新邮件开始检查
          for (const msg of messages) {
            // 获取邮件详情
            const detail = await this.getMessage(msg.id);

            // 从邮件内容中提取6位验证码
            const code = this.extractCode(detail);
            if (code) {
              console.log(`✅ 提取到验证码: ${code}`);
              return code;
            }
          }
          lastMsgCount = messages.length;
        }

        // 等待后重试
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const remaining = Math.round((timeout - (Date.now() - startTime)) / 1000);
        process.stdout.write(`\r⏳ 等待中... 已等待 ${elapsed}s, 剩余 ${remaining}s`);
        await this.sleep(interval);
      } catch (err) {
        console.error(`\n⚠️ 轮询出错: ${err.message}`);
        await this.sleep(interval);
      }
    }

    throw new Error('等待验证码超时');
  }

  // ========================
  // 从邮件内容提取6位数字验证码
  // ========================
  extractCode(message) {
    // 合并 text 和 html 内容
    const text = [
      message.text || '',
      message.html?.[0] || message.html || '',
      message.subject || '',
    ].join('\n');

    // 常见验证码格式：
    // 1. 纯6位数字: 123456
    // 2. 带文字: 验证码是 123456, code: 123456, 您的验证码：123456
    // 3. HTML格式: <span>123456</span>
    
    // 模式1: 明确的验证码上下文
    const contextPatterns = [
      /(?:验证码|确认码|verification\s*code|confirmation\s*code|code|코드)[:：\s]*(\d{6})/i,
      /(\d{6})(?:\s*(?:是|is)\s*(?:您|your)\s*(?:的)?(?:验证码|code))/i,
      /<[^>]*>\s*(\d{6})\s*<\/[^>]*>/,
    ];

    for (const pattern of contextPatterns) {
      const match = text.match(pattern);
      if (match) return match[1];
    }

    // 模式2: 直接找6位连续数字（取第一个匹配）
    const allCodes = text.match(/\b\d{6}\b/g);
    if (allCodes && allCodes.length > 0) {
      // 过滤掉明显不是验证码的（如年份 2024xx, 电话号码等）
      const validCodes = allCodes.filter(code => {
        const n = parseInt(code);
        // 排除年份范围
        if (n >= 200000 && n <= 203000) return false;
        // 排除全相同数字（如 000000, 111111）
        if (/^(\d)\1{5}$/.test(code)) return false;
        return true;
      });
      if (validCodes.length > 0) return validCodes[0];
    }

    return null;
  }

  // ========================
  // 工具：等待
  // ========================
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ========================
  // 清理：删除邮箱账户（可选）
  // ========================
  async cleanup() {
    if (!this.token || !this.accountId) return;
    try {
      await axios.delete(`${API_BASE}/accounts/${this.accountId}`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      console.log(`🗑️ 临时邮箱已删除: ${this.email}`);
    } catch {
      // 删除失败不影响主流程
    }
  }
}

module.exports = TempMail;
