const puppeteer = require('puppeteer');
const fs = require('fs');
const readline = require('readline');
const config = require('./config');
const TempMail = require('./tempmail');
const GmailInbox = require('./gmail');

// ========================
// User-Agent 池
// ========================
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ========================
// 工具函数
// ========================

function log(msg, type = 'info') {
  const icons = { info: 'ℹ️', success: '✅', error: '❌', warn: '⚠️', wait: '⏳', retry: '🔄' };
  const colors = { info: '\x1b[36m', success: '\x1b[32m', error: '\x1b[31m', warn: '\x1b[33m', wait: '\x1b[35m', retry: '\x1b[33m' };
  const reset = '\x1b[0m';
  console.log(`${colors[type] || ''}${icons[type] || ''} ${msg}${reset}`);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 随机延迟（在 base 基础上 ±30%）
function randomDelay(base) {
  const variance = base * 0.3;
  return Math.round(base + (Math.random() * 2 - 1) * variance);
}

function generateNickname(prefix) {
  const rand = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${rand}`;
}

function generateGmailAlias(baseEmail) {
  if (!baseEmail || !baseEmail.includes('@')) {
    throw new Error('config.gmail.user 未配置或格式错误');
  }
  const [localPart, domain] = baseEmail.split('@');
  const rand = Math.random().toString(36).substring(2, 8) + Date.now().toString(36).slice(-4);
  return `${localPart}+nol_${rand}@${domain}`;
}

function readEmails() {
  const data = fs.readFileSync('email.txt', 'utf8');
  return data.split('\n')
    .map(e => e.trim())
    .filter(e => e !== '' && !e.startsWith('#'));
}

function askInput(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(prompt, ans => { rl.close(); resolve(ans.trim()); }));
}

function formatTime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m${s}s`;
}

// ========================
// 断点续传
// ========================
const PROGRESS_FILE = 'progress.json';

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    }
  } catch {}
  return null;
}

function saveProgress(data) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(data, null, 2));
}

function clearProgress() {
  try { fs.unlinkSync(PROGRESS_FILE); } catch {}
}

// ========================
// 点击按钮（增强版）
// ========================
async function clickNextButton(page) {
  const buttonTexts = [
    '下一步', '确认', '提交', '完成', '注册', '注册完成',
    '다음', '확인', '가입하기',
    'Next', 'Submit', 'Confirm', 'Continue', 'Register',
  ];

  for (const text of buttonTexts) {
    try {
      const btn = await page.$x(`//button[contains(text(), "${text}")] | //a[contains(text(), "${text}")]`);
      if (btn.length > 0) {
        await btn[0].click();
        log(`点击按钮: ${text}`, 'info');
        return true;
      }
    } catch {}
  }

  // Puppeteer 真实点击 submit
  try {
    const submitBtn = await page.$('button[type="submit"]');
    if (submitBtn) {
      await submitBtn.evaluate(el => el.scrollIntoView({ block: 'center' }));
      await new Promise(r => setTimeout(r, 300));
      await submitBtn.click();
      log('通过 Puppeteer 点击了 submit 按钮', 'info');
      return true;
    }
  } catch {}

  return false;
}

// ========================
// 公共注册流程（步骤3-6）
// ========================

async function completeRegistration(page, email, nickname) {
  await delay(3000);
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});

  // 设置密码
  log('设置密码...', 'wait');
  await delay(1000);

  const passwordInputs = await page.$$('input[type="password"]');
  if (passwordInputs.length >= 2) {
    await passwordInputs[0].click({ clickCount: 3 });
    await passwordInputs[0].type(config.password, { delay: 30 });
    await passwordInputs[1].click({ clickCount: 3 });
    await passwordInputs[1].type(config.password, { delay: 30 });
    log('已输入密码（新密码 + 确认）', 'info');
  } else if (passwordInputs.length === 1) {
    await passwordInputs[0].click({ clickCount: 3 });
    await passwordInputs[0].type(config.password, { delay: 30 });
    log('已输入密码', 'info');
  }

  await delay(500);
  await clickNextButton(page);
  await delay(2000);

  // 同意条款
  log('同意条款...', 'wait');

  const allAgreeSelectors = [
    'input[type="checkbox"]#all',
    'input[type="checkbox"][data-testid*="all"]',
  ];

  let clicked = false;
  for (const sel of allAgreeSelectors) {
    try {
      const el = await page.$(sel);
      if (el) { await el.click(); clicked = true; break; }
    } catch {}
  }

  if (!clicked) {
    const checkboxes = await page.$$('input[type="checkbox"]');
    for (const cb of checkboxes) {
      const checked = await page.evaluate(el => el.checked, cb).catch(() => false);
      if (!checked) await cb.click().catch(() => {});
    }
  }
  log('已勾选条款', 'info');

  await delay(500);
  await clickNextButton(page);
  await delay(2000);

  // 设置昵称
  nickname = nickname || generateNickname(config.nicknamePrefix);
  log(`设置昵称: ${nickname}`, 'wait');

  const nicknameInput = await page.$('input[type="text"]');
  if (nicknameInput) {
    await nicknameInput.click({ clickCount: 3 });
    await nicknameInput.type(nickname, { delay: 30 });
  }

  await delay(500);
  await clickNextButton(page);
  await delay(3000);

  return nickname;
}

// ========================
// 输入邮箱并发送验证码
// ========================

async function inputEmailAndSendCode(page, email) {
  const emailInput = await page.waitForSelector(
    'input[type="email"], input[id*="email"], input[autoComplete="email"], input[name*="email"]',
    { timeout: config.pageTimeout }
  );
  await emailInput.click({ clickCount: 3 });
  await emailInput.type(email, { delay: 50 });
  log(`已输入邮箱: ${email}`, 'info');

  // 触发 blur/change 事件
  await page.click('body');
  await delay(1000);

  // Puppeteer 真实点击
  try {
    const submitBtn = await page.$('button[type="submit"]');
    if (submitBtn) {
      await submitBtn.evaluate(el => el.scrollIntoView({ block: 'center' }));
      await new Promise(r => setTimeout(r, 300));
      await submitBtn.click();
      log('已点击 submit 按钮', 'info');
    } else {
      await clickNextButton(page);
    }
  } catch {
    await clickNextButton(page);
  }

  log('已发送验证码', 'info');
  await delay(2000);
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
  await delay(2000);
}

// ========================
// 输入验证码
// ========================

async function inputVerificationCode(page, code) {
  const inputs = await page.$$('input[type="tel"], input[type="number"], input[inputmode="numeric"], input[maxlength="1"], input[maxlength="6"]');

  if (inputs.length >= 6) {
    for (let i = 0; i < 6; i++) {
      await inputs[i].click();
      await inputs[i].type(code[i], { delay: 30 });
    }
  } else if (inputs.length >= 1) {
    await inputs[0].click({ clickCount: 3 });
    await inputs[0].type(code, { delay: 50 });
  } else {
    await page.keyboard.type(code, { delay: 50 });
  }
  log('已输入验证码', 'info');
}

// ========================
// 核心注册函数（带回调，支持重试）
// ========================

async function doRegister(browser, mode, email, referralCode, gmailInbox) {
  const page = await browser.newPage();
  await page.setUserAgent(randomUA());
  await page.setViewport({ width: 1280, height: 800 });

  // 反检测（每个新页面都设置）
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
    window.chrome = { runtime: {} };
  });

  let tempMail = null;
  let finalEmail = email;

  try {
    let url = config.baseUrl;
    if (referralCode) url += `?returnUrl=/?ref=${encodeURIComponent(referralCode)}`;

    // 全自动模式：创建临时邮箱
    if (mode === '1') {
      tempMail = new TempMail();
      log('创建临时邮箱...', 'wait');
      finalEmail = await tempMail.createAccount('nol');
      log(`临时邮箱: ${finalEmail}`, 'success');
    }

    // Gmail 模式：生成别名
    if (mode === '3') {
      finalEmail = generateGmailAlias(config.gmail.user);
      log(`Gmail 别名: ${finalEmail}`, 'success');
    }

    log('打开注册页面', 'wait');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: config.pageTimeout });

    // 输入邮箱
    await inputEmailAndSendCode(page, finalEmail);

    // 获取验证码
    let code;
    if (mode === '1') {
      code = await tempMail.waitForVerificationCode(config.verificationTimeout, 5000);
    } else if (mode === '2') {
      log(`📧 验证码已发送到: ${finalEmail}`, 'success');
      code = await askInput('请输入6位验证码: ');
      if (code.length !== 6 || !/^\d{6}$/.test(code)) throw new Error('验证码格式错误');
    } else if (mode === '3') {
      code = await gmailInbox.waitForVerificationCode(config.verificationTimeout, 5000);
    }
    log(`验证码: ${code}`, 'success');

    await inputVerificationCode(page, code);

    // 等待页面跳转（登录成功）
    await delay(2000);
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await delay(2000);

    log(`✅ 登录成功: ${finalEmail}`, 'success');
    return { success: true, email: finalEmail, url: page.url() };

  } catch (error) {
    log(`注册失败: ${finalEmail} - ${error.message}`, 'error');
    const screenshotPath = `error_${finalEmail.replace(/[@.]/g, '_')}_${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    log(`错误截图: ${screenshotPath}`, 'warn');
    return { success: false, email: finalEmail, error: error.message };
  } finally {
    if (tempMail) await tempMail.cleanup().catch(() => {});
    await page.close();
  }
}

// ========================
// 带重试的注册包装
// ========================

async function registerWithRetry(browser, mode, email, referralCode, gmailInbox) {
  const maxRetries = config.maxRetries || 1;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (attempt > 1) {
      log(`🔄 第 ${attempt}/${maxRetries} 次重试...`, 'retry');
      await delay(randomDelay(config.delay));
    }

    const result = await doRegister(browser, mode, email, referralCode, gmailInbox);
    if (result.success) return result;

    if (attempt < maxRetries) {
      log(`重试等待 ${Math.round(config.delay / 1000)}s...`, 'wait');
    }
  }

  // 所有重试都失败
  return { success: false, email, error: `重试 ${maxRetries} 次后仍失败` };
}

// ========================
// 主流程
// ========================

async function main() {
  console.log(`
╔══════════════════════════════════════╗
║     NOL World 账户批量注册工具       ║
║     v1.2 — 支持重试/断点续传         ║
╚══════════════════════════════════════╝
  `);

  // 检查断点续传
  const savedProgress = loadProgress();
  let resumeFrom = 0;
  let mode, referralCode, count, gmailInbox = null;

  if (savedProgress) {
    log(`发现上次进度: 模式${savedProgress.mode}, 已完成 ${savedProgress.completed}/${savedProgress.total}`, 'warn');
    const answer = await askInput('是否继续上次进度？(y/n): ');
    if (answer.toLowerCase() === 'y') {
      mode = savedProgress.mode;
      referralCode = savedProgress.referralCode;
      count = savedProgress.total;
      resumeFrom = savedProgress.completed;
      log(`从第 ${resumeFrom + 1} 个继续`, 'info');
    } else {
      clearProgress();
    }
  }

  if (!mode) {
    console.log('请选择注册模式:');
    console.log('  1. 🤖 全自动模式 — mail.tm 临时邮箱');
    console.log('  2. 📧 手动模式 — 使用 email.txt 中的邮箱');
    console.log('  3. 📬 Gmail 模式 — Gmail + 别名，自动收验证码');
    mode = await askInput('请输入 1、2 或 3: ');

    if (!['1', '2', '3'].includes(mode)) { log('无效选项', 'error'); process.exit(1); }

    referralCode = config.defaultReferralCode;
    if (!referralCode) referralCode = await askInput('请输入邀请码 (可留空): ');
  }

  // 模式特定配置
  let emails;
  if (mode === '1') {
    if (!count) {
      count = parseInt(await askInput('请输入要注册的数量: '), 10);
      if (isNaN(count) || count < 1) { log('数量无效', 'error'); process.exit(1); }
    }
  } else if (mode === '2') {
    emails = readEmails();
    if (emails.length === 0) { log('email.txt 为空', 'error'); process.exit(1); }
    count = emails.length;
    log(`共加载 ${count} 个邮箱`, 'info');
  } else if (mode === '3') {
    if (!config.gmail.user || !config.gmail.appPassword) {
      log('Gmail 配置缺失！请创建 config.local.js 并添加:', 'error');
      log('  module.exports = { gmail: { user: "xxx@gmail.com", appPassword: "xxxx xxxx xxxx xxxx" } };', 'error');
      log('应用专用密码获取: https://myaccount.google.com/apppasswords', 'info');
      process.exit(1);
    }
    if (!count) {
      count = parseInt(await askInput('请输入要注册的数量: '), 10);
      if (isNaN(count) || count < 1) { log('数量无效', 'error'); process.exit(1); }
    }
    log('连接 Gmail...', 'wait');
    gmailInbox = new GmailInbox(config.gmail.user, config.gmail.appPassword);
    try {
      await gmailInbox.connect();
    } catch (err) {
      log(`Gmail 连接失败: ${err.message}`, 'error');
      log('可能原因: 1) 网络/VPN问题 2) IMAP未开启 3) 应用密码错误', 'error');
      log('请检查: https://mail.google.com/mail/u/0/#settings/fwdandpop 确保IMAP已启用', 'info');
      process.exit(1);
    }
  }

  // 运行时选择 headless
  if (!savedProgress) {
    const headlessInput = await askInput('是否后台运行浏览器？(y/n, 默认n): ');
    if (headlessInput.toLowerCase() === 'y') {
      config.headless = 'new';
      log('浏览器将在后台运行', 'info');
    }
  }

  log('启动浏览器...', 'wait');
  const browser = await puppeteer.launch({
    headless: config.headless,
    executablePath: (function() {
      const paths = [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ];
      const fs = require('fs');
      for (const p of paths) { if (fs.existsSync(p)) return p; }
      return undefined; // 让 Puppeteer 用自带 Chromium
    })(),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1280,800',
      '--disable-dev-shm-usage',
    ],
    defaultViewport: null,
  });

  const results = { success: [], failed: [] };
  const startTime = Date.now();

  // 注册循环
  for (let i = resumeFrom; i < count; i++) {
    const current = i + 1;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    log(`\n━━━ 进度: ${current}/${count} (成功:${results.success.length} 失败:${results.failed.length} 耗时:${formatTime(elapsed)}) ━━━`, 'info');

    let email;
    if (mode === '2') email = emails[i];

    const result = await registerWithRetry(browser, mode, email, referralCode, gmailInbox);

    if (result.success) results.success.push(result);
    else results.failed.push(result);

    // 保存断点
    saveProgress({
      mode, referralCode, total: count,
      completed: current,
      success: results.success,
      failed: results.failed,
    });

    // 随机延迟
    if (current < count) {
      const waitMs = randomDelay(config.delay);
      log(`等待 ${Math.round(waitMs / 1000)}s...`, 'wait');
      await delay(waitMs);
    }
  }

  if (gmailInbox) await gmailInbox.disconnect().catch(() => {});
  await browser.close();

  // 统计
  const totalTime = Math.round((Date.now() - startTime) / 1000);
  const successRate = count > 0 ? Math.round(results.success.length / count * 100) : 0;

  console.log(`
╔══════════════════════════════════════╗
║            注册结果统计              ║
╠══════════════════════════════════════╣
║  总计:   ${count}
║  成功:   ${results.success.length}  (${successRate}%)
║  失败:   ${results.failed.length}
║  耗时:   ${formatTime(totalTime)}
║  重试:   ${config.maxRetries || 1} 次
╚══════════════════════════════════════╝
  `);

  // 保存结果
  const report = {
    timestamp: new Date().toISOString(),
    mode: mode === '1' ? 'auto' : mode === '2' ? 'manual' : 'gmail',
    total: count,
    successRate: `${successRate}%`,
    elapsed: formatTime(totalTime),
    success: results.success,
    failed: results.failed,
  };
  fs.writeFileSync('register_results.json', JSON.stringify(report, null, 2));
  log('结果已保存到 register_results.json', 'success');

  if ((mode === '1' || mode === '3') && results.success.length > 0) {
    const accounts = results.success.map(r => `${r.email}|${r.password}|${r.nickname}`).join('\n');
    fs.writeFileSync('accounts.txt', accounts + '\n');
    log('账号信息已保存到 accounts.txt', 'success');
  }

  // 清理断点
  clearProgress();

  if (results.failed.length > 0) {
    log('\n失败列表:', 'error');
    results.failed.forEach(r => log(`  - ${r.email}: ${r.error}`, 'error'));
  }
}

main().catch(err => {
  log(`程序异常: ${err.message}`, 'error');
  process.exit(1);
});

