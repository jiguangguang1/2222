const puppeteer = require('puppeteer');
const fs = require('fs');
const readline = require('readline');
const config = require('./config');
const TempMail = require('./tempmail');
const GmailInbox = require('./gmail');

// ========================
// 工具函数
// ========================

function log(msg, type = 'info') {
  const icons = { info: 'ℹ️', success: '✅', error: '❌', warn: '⚠️', wait: '⏳' };
  const colors = { info: '\x1b[36m', success: '\x1b[32m', error: '\x1b[31m', warn: '\x1b[33m', wait: '\x1b[35m' };
  const reset = '\x1b[0m';
  console.log(`${colors[type] || ''}${icons[type] || ''} ${msg}${reset}`);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateNickname(prefix) {
  const rand = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${rand}`;
}

function generateGmailAlias(baseEmail) {
  // Gmail + 别名: user+random@gmail.com
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

// 辅助：点击下一个/确认/提交按钮
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

  try {
    const submitBtn = await page.$('button[type="submit"]');
    if (submitBtn) {
      const disabled = await page.evaluate(el => el.disabled, submitBtn);
      if (!disabled) {
        await submitBtn.click();
        log('点击了 submit 按钮', 'info');
        return true;
      }
    }
  } catch {}

  return false;
}

// ========================
// 公共注册流程（步骤3-6）
// ========================

async function completeRegistration(page, email, nickname) {
  // 等待自动验证并跳转
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
      if (el) {
        await el.click();
        clicked = true;
        break;
      }
    } catch {}
  }

  if (!clicked) {
    const checkboxes = await page.$$('input[type="checkbox"]');
    for (const cb of checkboxes) {
      const checked = await page.evaluate(el => el.checked, cb).catch(() => false);
      if (!checked) {
        await cb.click().catch(() => {});
      }
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
// 输入邮箱并发送验证码（公共步骤1-2）
// ========================

async function inputEmailAndSendCode(page, email) {
  // 等待邮箱输入框出现
  const emailInput = await page.waitForSelector(
    'input[type="email"], input[id*="email"], input[autoComplete="email"], input[name*="email"]',
    { timeout: config.pageTimeout }
  );
  await emailInput.click({ clickCount: 3 });
  await emailInput.type(email, { delay: 50 });
  log(`已输入邮箱: ${email}`, 'info');

  // 点击输入框外部，触发可能的 change/blur 事件
  await page.click('body');
  await delay(1000);

  // 多种方式尝试点击发送按钮
  let clicked = false;

  // 方式1: 直接 JS 点击 submit 按钮
  try {
    await page.evaluate(() => {
      const btn = document.querySelector('button[type="submit"]');
      if (btn) { btn.disabled = false; btn.click(); }
    });
    clicked = true;
    log('通过 JS 点击了 submit 按钮', 'info');
  } catch {}

  if (!clicked) {
    // 方式2: 用 clickNextButton
    await clickNextButton(page);
  }

  log('已发送验证码', 'info');
  await delay(2000);

  // 等待页面跳转（不强制要求成功）
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
  await delay(2000);
}

// ========================
// 输入验证码（公共步骤2）
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
// 核心：全自动注册（mail.tm 临时邮箱）
// ========================

async function registerAuto(browser, referralCode) {
  const page = await browser.newPage();
  const tempMail = new TempMail();
  let email;

  try {
    log('创建临时邮箱...', 'wait');
    email = await tempMail.createAccount('nol');
    log(`临时邮箱: ${email}`, 'success');

    await page.setViewport({ width: 1280, height: 800 });

    let url = config.baseUrl;
    if (referralCode) {
      url += `?returnUrl=/?ref=${encodeURIComponent(referralCode)}`;
    }

    log('打开注册页面', 'wait');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: config.pageTimeout });

    await inputEmailAndSendCode(page, email);

    const code = await tempMail.waitForVerificationCode(config.verificationTimeout, 5000);
    log(`自动获取验证码: ${code}`, 'success');

    await inputVerificationCode(page, code);

    const nickname = await completeRegistration(page, email);

    log(`✅ 注册成功: ${email} (昵称: ${nickname})`, 'success');
    return { success: true, email, nickname, password: config.password };

  } catch (error) {
    log(`注册失败: ${email || 'unknown'} - ${error.message}`, 'error');
    const screenshotPath = `error_${(email || 'unknown').replace(/[@.]/g, '_')}_${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    log(`错误截图: ${screenshotPath}`, 'warn');
    return { success: false, email: email || 'unknown', error: error.message };
  } finally {
    await tempMail.cleanup().catch(() => {});
    await page.close();
  }
}

// ========================
// 核心：Gmail 自动注册（+ 别名）
// ========================

async function registerGmail(browser, gmailInbox, referralCode) {
  const page = await browser.newPage();
  const email = generateGmailAlias(config.gmail.user);
  let nickname;

  try {
    log(`Gmail 别名邮箱: ${email}`, 'success');

    await page.setViewport({ width: 1280, height: 800 });

    let url = config.baseUrl;
    if (referralCode) {
      url += `?returnUrl=/?ref=${encodeURIComponent(referralCode)}`;
    }

    log('打开注册页面', 'wait');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: config.pageTimeout });

    await inputEmailAndSendCode(page, email);

    const code = await gmailInbox.waitForVerificationCode(config.verificationTimeout, 5000);
    log(`自动获取验证码: ${code}`, 'success');

    await inputVerificationCode(page, code);

    nickname = await completeRegistration(page, email);

    log(`✅ 注册成功: ${email} (昵称: ${nickname})`, 'success');
    return { success: true, email, nickname, password: config.password };

  } catch (error) {
    log(`注册失败: ${email} - ${error.message}`, 'error');
    const screenshotPath = `error_${email.replace(/[@.]/g, '_')}_${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    log(`错误截图: ${screenshotPath}`, 'warn');
    return { success: false, email, error: error.message };
  } finally {
    await page.close();
  }
}

// ========================
// 核心：手动邮箱注册
// ========================

async function registerManual(browser, email, referralCode) {
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1280, height: 800 });

    let url = config.baseUrl;
    if (referralCode) {
      url += `?returnUrl=/?ref=${encodeURIComponent(referralCode)}`;
    }

    log(`打开注册页面: ${email}`, 'wait');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: config.pageTimeout });

    await inputEmailAndSendCode(page, email);

    log(`📧 验证码已发送到: ${email}`, 'success');
    const code = await askInput('请输入6位验证码: ');

    if (code.length !== 6 || !/^\d{6}$/.test(code)) {
      throw new Error('验证码格式错误');
    }

    await inputVerificationCode(page, code);

    const nickname = await completeRegistration(page, email);

    log(`✅ 注册成功: ${email} (昵称: ${nickname})`, 'success');
    return { success: true, email, nickname, password: config.password };

  } catch (error) {
    log(`注册失败: ${email} - ${error.message}`, 'error');
    const screenshotPath = `error_${email.replace(/[@.]/g, '_')}_${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    return { success: false, email, error: error.message };
  } finally {
    await page.close();
  }
}

// ========================
// 主流程
// ========================

async function main() {
  console.log(`
╔══════════════════════════════════════╗
║     NOL World 账户批量注册工具       ║
║     v1.1 — 支持3种模式               ║
╚══════════════════════════════════════╝
  `);

  console.log('请选择注册模式:');
  console.log('  1. 🤖 全自动模式 — mail.tm 临时邮箱');
  console.log('  2. 📧 手动模式 — 使用 email.txt 中的邮箱');
  console.log('  3. 📬 Gmail 模式 — Gmail + 别名，自动收验证码');
  const mode = await askInput('请输入 1、2 或 3: ');

  let referralCode = config.defaultReferralCode;
  if (!referralCode) {
    referralCode = await askInput('请输入邀请码 (可留空): ');
  }

  let count;
  let gmailInbox = null;

  if (mode === '1') {
    count = parseInt(await askInput('请输入要注册的数量: '), 10);
    if (isNaN(count) || count < 1) { log('数量无效', 'error'); process.exit(1); }
  } else if (mode === '2') {
    var emails = readEmails();
    if (emails.length === 0) { log('email.txt 为空', 'error'); process.exit(1); }
    count = emails.length;
    log(`共加载 ${count} 个邮箱`, 'info');
  } else if (mode === '3') {
    // 检查 Gmail 配置
    if (!config.gmail.user || !config.gmail.appPassword) {
      log('Gmail 配置缺失！请创建 config.local.js 并添加:', 'error');
      log('  module.exports = { gmail: { user: "xxx@gmail.com", appPassword: "xxxx xxxx xxxx xxxx" } };', 'error');
      log('应用专用密码获取: https://myaccount.google.com/apppasswords', 'info');
      process.exit(1);
    }
    count = parseInt(await askInput('请输入要注册的数量: '), 10);
    if (isNaN(count) || count < 1) { log('数量无效', 'error'); process.exit(1); }

    // 连接 Gmail
    log('连接 Gmail...', 'wait');
    gmailInbox = new GmailInbox(config.gmail.user, config.gmail.appPassword);
    await gmailInbox.connect();
  } else {
    log('无效选项', 'error');
    process.exit(1);
  }

  log('启动浏览器...', 'wait');
  const browser = await puppeteer.launch({
    headless: config.headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1280,800',
    ],
    defaultViewport: null,
  });

  const pages = await browser.pages();
  if (pages.length > 0) {
    await pages[0].evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });
  }

  const results = { success: [], failed: [] };

  if (mode === '1') {
    for (let i = 0; i < count; i++) {
      log(`\n━━━ 进度: ${i + 1}/${count} ━━━`, 'info');
      const result = await registerAuto(browser, referralCode);
      if (result.success) results.success.push(result);
      else results.failed.push(result);

      if (i < count - 1) {
        log(`等待 ${config.delay / 1000}s...`, 'wait');
        await delay(config.delay);
      }
    }
  } else if (mode === '2') {
    for (let i = 0; i < emails.length; i += config.maxConcurrentRequests) {
      const batch = emails.slice(i, i + config.maxConcurrentRequests);
      const batchNum = Math.floor(i / config.maxConcurrentRequests) + 1;
      const totalBatches = Math.ceil(emails.length / config.maxConcurrentRequests);

      log(`\n━━━ 批次 ${batchNum}/${totalBatches} ━━━`, 'info');

      for (const email of batch) {
        const result = await registerManual(browser, email, referralCode);
        if (result.success) results.success.push(result);
        else results.failed.push(result);
      }

      if (i + config.maxConcurrentRequests < emails.length) {
        log(`等待 ${config.delay / 1000}s...`, 'wait');
        await delay(config.delay);
      }
    }
  } else if (mode === '3') {
    for (let i = 0; i < count; i++) {
      log(`\n━━━ 进度: ${i + 1}/${count} ━━━`, 'info');
      const result = await registerGmail(browser, gmailInbox, referralCode);
      if (result.success) results.success.push(result);
      else results.failed.push(result);

      if (i < count - 1) {
        log(`等待 ${config.delay / 1000}s...`, 'wait');
        await delay(config.delay);
      }
    }

    // 断开 Gmail
    await gmailInbox.disconnect().catch(() => {});
  }

  await browser.close();

  // 统计
  console.log(`
╔══════════════════════════════════╗
║         注册结果统计             ║
╠══════════════════════════════════╣
║  总计: ${count}
║  成功: ${results.success.length}
║  失败: ${results.failed.length}
╚══════════════════════════════════╝
  `);

  const report = {
    timestamp: new Date().toISOString(),
    mode: mode === '1' ? 'auto' : mode === '2' ? 'manual' : 'gmail',
    total: count,
    success: results.success,
    failed: results.failed,
  };
  fs.writeFileSync('register_results.json', JSON.stringify(report, null, 2));
  log('结果已保存到 register_results.json', 'success');

  if ((mode === '1' || mode === '3') && results.success.length > 0) {
    const accounts = results.success.map(r => `${r.email}|${r.password}|${r.nickname}`).join('\n');
    fs.writeFileSync('accounts.txt', accounts + '\n');
    log('账号信息已保存到 accounts.txt (格式: 邮箱|密码|昵称)', 'success');
  }

  if (results.failed.length > 0) {
    log('\n失败列表:', 'error');
    results.failed.forEach(r => log(`  - ${r.email}: ${r.error}`, 'error'));
  }
}

main().catch(err => {
  log(`程序异常: ${err.message}`, 'error');
  process.exit(1);
});
