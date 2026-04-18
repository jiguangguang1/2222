/**
 * Gmail 自动获取验证码模块
 * 使用 IMAP + app password 连接 Gmail，自动提取 NOL World 验证码
 */

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

class GmailInbox {
  constructor(user, appPassword) {
    if (!user || !appPassword) {
      throw new Error('Gmail 配置缺失：请在 config.local.js 中设置 gmail.user 和 gmail.appPassword');
    }
    this.user = user;
    this.appPassword = appPassword.replace(/\s/g, ''); // 去除空格
    this.client = null;
    this.connected = false;
    this.lastError = null;
  }

  // ========================
  // 连接 Gmail IMAP
  // ========================
  async connect() {
    // 先清理旧连接
    await this.disconnect();

    this.connected = false;
    this.lastError = null;

    this.client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: {
        user: this.user,
        pass: this.appPassword,
      },
      logger: false,
      emitLogs: false,
    });

    // 关键：监听错误事件，防止 Node.js 未捕获错误崩溃
    this.client.on('error', (err) => {
      console.error(`\n⚠️ Gmail IMAP 连接错误: ${err.message}`);
      this.connected = false;
      this.lastError = err;
    });

    this.client.on('close', () => {
      this.connected = false;
    });

    await this.client.connect();
    this.connected = true;
    console.log(`📧 Gmail 已连接: ${this.user}`);
  }

  // ========================
  // 断开连接
  // ========================
  async disconnect() {
    if (this.client) {
      try {
        // 移除监听器，避免断开时触发 error 事件
        this.client.removeAllListeners('error');
        this.client.removeAllListeners('close');
        await this.client.logout();
      } catch {
        // 忽略断开错误
      }
      this.client = null;
      this.connected = false;
    }
  }

  // ========================
  // 检查连接是否健康，不健康则重连
  // ========================
  async ensureConnected() {
    if (!this.connected || !this.client || this.lastError) {
      console.log('\n🔄 Gmail 连接异常，正在重连...');
      await this.connect();
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
    await this.ensureConnected();

    const startTime = Date.now();
    let seenUids = new Set();

    console.log(`⏳ 等待 Gmail 验证码邮件... (超时: ${timeout / 1000}s)`);

    // 先记录最新 100 封邮件的 UID 作为基准，避免拿到旧邮件
    // （扫描全量邮箱太慢，只看最近的就够了）
    try {
      await this.ensureConnected();
      const lock = await this.client.getMailboxLock('INBOX');
      try {
        const status = await this.client.status('INBOX', { messages: true });
        const total = status.messages || 0;
        const startSeq = Math.max(1, total - 99);
        for await (const message of this.client.fetch(`${startSeq}:*`, { uid: true })) {
          seenUids.add(message.uid);
        }
      } finally {
        lock.release();
      }
    } catch (err) {
      console.error(`\n⚠️ 初始化扫描出错: ${err.message}`);
      // 不阻塞，继续轮询
    }

    while (Date.now() - startTime < timeout) {
      try {
        await this.ensureConnected();
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

            const text = [
              parsed.text || '',
              parsed.html || '',
              subject,
            ].join('\n');

            const code = this.extractCode(text);
            if (code) {
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
        // 标记连接异常，下次循环会自动重连
        this.connected = false;
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
