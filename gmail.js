/**
 * Gmail 自动获取验证码模块
 * 使用 IMAP + app password 连接 Gmail，自动提取 NOL World 验证码
 */

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

class GmailInbox {
  constructor(user, appPassword) {
    if (!user || !appPassword) {
      throw new Error('Gmail 配置缺失：请在 config.js 或环境变量中设置 gmail.user 和 gmail.appPassword');
    }
    this.user = user;
    this.appPassword = appPassword.replace(/\s/g, ''); // 去除空格
    this.client = null;
  }

  // ========================
  // 连接 Gmail IMAP
  // ========================
  async connect() {
    this.client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: {
        user: this.user,
        pass: this.appPassword,
      },
      logger: false,
    });

    await this.client.connect();
    console.log(`📧 Gmail 已连接: ${this.user}`);
  }

  // ========================
  // 断开连接
  // ========================
  async disconnect() {
    if (this.client) {
      await this.client.logout().catch(() => {});
      this.client = null;
    }
  }

  // ========================
  // 从文本中提取6位验证码
  // ========================
  extractCode(text) {
    if (!text) return null;

    // 模式1: 带上下文的验证码
    const contextPatterns = [
      /(?:验证码|确认码|verification\s*code|confirmation\s*code|code|코드)[:：\s]*(\d{6})/i,
      /(\d{6})(?:\s*(?:是|is)\s*(?:您|your)\s*(?:的)?(?:验证码|code))/i,
      /<[^>]*>\s*(\d{6})\s*<\/[^>]*>/,
    ];

    for (const pattern of contextPatterns) {
      const match = text.match(pattern);
      if (match) return match[1];
    }

    // 模式2: 直接找6位连续数字
    const allCodes = text.match(/\b\d{6}\b/g);
    if (allCodes && allCodes.length > 0) {
      const validCodes = allCodes.filter(code => {
        const n = parseInt(code);
        if (n >= 200000 && n <= 203000) return false; // 排除年份
        if (/^(\d)\1{5}$/.test(code)) return false;   // 排除全相同
        return true;
      });
      if (validCodes.length > 0) return validCodes[0];
    }

    return null;
  }

  // ========================
  // 等待验证码邮件，自动提取6位数字
  // ========================
  async waitForVerificationCode(timeout = 300000, interval = 5000) {
    if (!this.client) await this.connect();

    const startTime = Date.now();
    let seenUids = new Set();

    console.log(`⏳ 等待 Gmail 验证码邮件... (超时: ${timeout / 1000}s)`);

    // 先记录已有的邮件 UID，避免拿到旧邮件
    try {
      const lock = await this.client.getMailboxLock('INBOX');
      try {
        for await (const message of this.client.fetch('1:*', { uid: true })) {
          seenUids.add(message.uid);
        }
      } finally {
        lock.release();
      }
    } catch {}

    while (Date.now() - startTime < timeout) {
      try {
        const lock = await this.client.getMailboxLock('INBOX');
        try {
          // 搜索最近的未读邮件
          const searchResult = await this.client.search({ seen: false });

          for (const uid of searchResult) {
            if (seenUids.has(uid)) continue;

            const message = await this.client.fetchOne(String(uid), {
              source: true,
              uid: true,
            });

            if (!message || !message.source) continue;

            const parsed = await simpleParser(message.source);
            const from = parsed.from?.text || '';
            const subject = parsed.subject || '';

            // 记录发件人信息，便于调试
            const text = [
              parsed.text || '',
              parsed.html || '',
              subject,
            ].join('\n');

            const code = this.extractCode(text);
            if (code) {
              // 如果是 NOL 邮件，直接用；如果是其他邮件，只在没找到 NOL 邮件时用
              console.log(`\n✅ 从邮件 "${subject}" (from: ${from}) 提取到验证码: ${code}`);
              await this.client.messageFlagsAdd(String(uid), ['\\Seen']).catch(() => {});
              return code;
            }

            seenUids.add(uid);
          }
        } finally {
          lock.release();
        }

        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const remaining = Math.round((timeout - (Date.now() - startTime)) / 1000);
        process.stdout.write(`\r⏳ Gmail 等待中... 已等待 ${elapsed}s, 剩余 ${remaining}s`);

        await this.sleep(interval);
      } catch (err) {
        console.error(`\n⚠️ Gmail 轮询出错: ${err.message}`);
        // 尝试重连
        try {
          await this.disconnect();
          await this.connect();
        } catch {}
        await this.sleep(interval);
      }
    }

    throw new Error('Gmail 等待验证码超时');
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = GmailInbox;
