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
  async waitForVerificationCode(timeout = 300000, interval = 5000) {
    const startTime = Date.now();
    let lastMsgCount = 0;

    console.log(`📧 临时邮箱已创建: ${this.email}`);
    console.log(`⏳ 等待验证码邮件... (超时: ${timeout / 1000}s)`);

    while (Date.now() - startTime < timeout) {
      try {
        const messages = await this.getMessages();

        if (messages.length > lastMsgCount) {
          console.log(`📬 收到 ${messages.length} 封邮件`);

          for (const msg of messages) {
            const detail = await this.getMessage(msg.id);
            const code = this.extractCode(detail);
            if (code) {
              console.log(`✅ 提取到验证码: ${code}`);
              return code;
            }
          }
          lastMsgCount = messages.length;
        }

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
    const text = [
      message.text || '',
      message.html?.[0] || message.html || '',
      message.subject || '',
    ].join('\n');

    const contextPatterns = [
      /(?:验证码|确认码|verification\s*code|confirmation\s*code|code|코드)[:：\s]*(\d{6})/i,
      /(\d{6})(?:\s*(?:是|is)\s*(?:您|your)\s*(?:的)?(?:验证码|code))/i,
      /<[^>]*>\s*(\d{6})\s*<\/[^>]*>/,
    ];

    for (const pattern of contextPatterns) {
      const match = text.match(pattern);
      if (match) return match[1];
    }

    const allCodes = text.match(/\b\d{6}\b/g);
    if (allCodes && allCodes.length > 0) {
      const validCodes = allCodes.filter(code => {
        const n = parseInt(code);
        if (n >= 202000 && n <= 203000) return false; // 排除年份 (2020-2030)
        if (/^(\d)\1{5}$/.test(code)) return false;
        return true;
      });
      if (validCodes.length > 0) return validCodes[0];
    }

    return null;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ========================
  // 清理：删除邮箱账户
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
