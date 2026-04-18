const puppeteer = require('puppeteer');
const fs = require('fs');
const readline = require('readline');
const config = require('./config');
const TempMail = require('./tempmail');

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

  // 尝试找 submit 类型按钮
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
// 核心：全自动注册（使用临时邮箱）
// ========================

async function registerAuto(browser, referralCode) {
  const page = await browser.newPage();
  const tempMail = new TempMail();
  let email;

  try {
    // ---- 创建临时邮箱 ----
    log('创建临时邮箱...', 'wait');
    email = await tempMail.createAccount('nol');
    log(`临时邮箱: ${email}`, 'success');

    // 设置 viewport
    await page.setViewport({ width: 1280, height: 800 });

    // 构建注册URL
    let url = config.baseUrl;
    if (referralCode) {
      url += `?returnUrl=/?ref=${encodeURIComponent(referralCode)}`;
    }

    log(`打开注册页面`, 'wait');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: config.pageTimeout });

    // ---- 步骤1：输入邮箱，发送验证码 ----
    const emailInput = await page.waitForSelector(
      'input[type="email"], input[id*="email"], input[autoComplete="email"]',
      { timeout: config.pageTimeout }
    );
    await emailInput.click({ clickCount: 3 });
    await emailInput.type(email, { delay: 50 });
    log(`已输入邮箱: ${email}`, 'info');

    await delay(500);
    const submitBtn = await page.waitForSelector('button[type="submit"]', { timeout: 10000 });
    await submitBtn.click();
    log('已发送验证码', 'info');

    // 等待跳转到验证码页面
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    await delay(2000);

    // ---- 步骤2：自动等待验证码 ----
    const code = await tempMail.waitForVerificationCode(config.verificationTimeout, 5000);
    log(`自动获取验证码: ${code}`, 'success');

    // ---- 步骤3：输入验证码 ----
    // NOL World 可能是6个独立输入框或1个整体输入框
    const inputs = await page.$$('input[type="tel"], input[type="number"], input[inputmode="numeric"], input[maxlength="1"], input[maxlength="6"]');

    if (inputs.length >= 6) {
      // 6个独立输入框
      for (let i = 0; i < 6; i++) {
        await inputs[i].click();
        await inputs[i].type(code[i], { delay: 30 });
      }
    } else if (inputs.length >= 1) {
      // 单个输入框
      await inputs[0].click({ clickCount: 3 });
      await inputs[0].type(code, { delay: 50 });
    } else {
      await page.keyboard.type(code, { delay: 50 });
    }
    log('已输入验证码', 'info');

    // 等待自动验证并跳转
    await delay(3000);
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});

    // ---- 步骤4：设置密码 ----
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

    // ---- 步骤5：同意条款 ----
    log('同意条款...', 'wait');

    // 先尝试找"全部同意"按钮/复选框
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
      // 逐个勾选所有复选框
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

    // ---- 步骤6：设置昵称 ----
    const nickname = generateNickname(config.nicknamePrefix);
    log(`设置昵称: ${nickname}`, 'wait');

    const nicknameInput = await page.$('input[type="text"]');
    if (nicknameInput) {
      await nicknameInput.click({ clickCount: 3 });
      await nicknameInput.type(nickname, { delay: 30 });
    }

    await delay(500);
    await clickNextButton(page);
    await delay(3000);

    // ---- 完成 ----
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
// 核心：手动邮箱注册（使用 email.txt 中的邮箱）
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

    // 步骤1：输入邮箱，发送验证码
    const emailInput = await page.waitForSelector(
      'input[type="email"], input[id*="email"], input[autoComplete="email"]',
      { timeout: config.pageTimeout }
    );
    await emailInput.click({ clickCount: 3 });
    await emailInput.type(email, { delay: 50 });

    await delay(500);
    const submitBtn = await page.waitForSelector('button[type="submit"]', { timeout: 10000 });
    await submitBtn.click();
    log('已发送验证码', 'info');

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    await delay(2000);

    // 步骤2：手动输入验证码
    log(`📧 验证码已发送到: ${email}`, 'success');
    const code = await askInput('请输入6位验证码: ');

    if (code.length !== 6 || !/^\d{6}$/.test(code)) {
      throw new Error('验证码格式错误');
    }

    // 输入验证码
    const inputs = await page.$$('input[type="tel"], input[type="number"], input[inputmode="numeric"], input[maxlength="1"], input[maxlength="6"]');
    if (inputs.length >= 6) {
      for (let i = 0; i < 6; i++) {
        await inputs[i].click();
        await inputs[i].type(code[i], { delay: 30 });
      }
    } else if (inputs.length >= 1) {
      await inputs[0].click({ clickCount: 3 });
      await inputs[0].type(code, { delay: 50 });
    }

    await delay(3000);
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});

    // 步骤3-6：同自动模式
    // 密码
    const passwordInputs = await page.$$('input[type="password"]');
    if (passwordInputs.length >= 2) {
      await passwordInputs[0].click({ clickCount: 3 });
      await passwordInputs[0].type(config.password, { delay: 30 });
      await passwordInputs[1].click({ clickCount: 3 });
      await passwordInputs[1].type(config.password, { delay: 30 });
    } else if (passwordInputs.length === 1) {
      await passwordInputs[0].click({ clickCount: 3 });
      await passwordInputs[0].type(config.password, { delay: 30 });
    }
    await delay(500);
    await clickNextButton(page);
    await delay(2000);

    // 条款
    const checkboxes = await page.$$('input[type="checkbox"]');
    for (const cb of checkboxes) {
      const checked = await page.evaluate(el => el.checked, cb).catch(() => false);
      if (!checked) await cb.click().catch(() => {});
    }
    await delay(500);
    await clickNextButton(page);
    await delay(2000);

    // 昵称
    const nickname = generateNickname(config.nicknamePrefix);
    const nicknameInput = await page.$('input[type="text"]');
    if (nicknameInput) {
      await nicknameInput.click({ clickCount: 3 });
      await nicknameInput.type(nickname, { delay: 30 });
    }
    await delay(500);
    await clickNextButton(page);
    await delay(3000);

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
║     支持自动 / 手动两种模式          ║
╚══════════════════════════════════════╝
  `);

  // 选择模式
  console.log('请选择注册模式:');
  console.log('  1. 🤖 全自动模式 — 自动创建临时邮箱，自动收验证码');
  console.log('  2. 📧 手动模式 — 使用 email.txt 中的邮箱，手动输入验证码');
  const mode = await askInput('请输入 1 或 2: ');

  const isAuto = mode === '1';

  // 获取邀请码
  let referralCode = config.defaultReferralCode;
  if (!referralCode) {
    referralCode = await askInput('请输入邀请码 (可留空): ');
  }

  // 确定注册数量
  let count;
  if (isAuto) {
    count = parseInt(await askInput('请输入要注册的数量: '), 10);
    if (isNaN(count) || count < 1) {
      log('数量无效', 'error');
      process.exit(1);
    }
  } else {
    // 手动模式从 email.txt 读取
    var emails = readEmails();
    if (emails.length === 0) {
      log('email.txt 为空', 'error');
      process.exit(1);
    }
    count = emails.length;
    log(`共加载 ${count} 个邮箱`, 'info');
  }

  // 启动浏览器
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

  // 反检测
  const pages = await browser.pages();
  if (pages.length > 0) {
    await pages[0].evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });
  }

  const results = { success: [], failed: [] };

  if (isAuto) {
    // ---- 全自动模式：逐个注册 ----
    // 注意：不并行，因为每个都需要等邮件
    for (let i = 0; i < count; i++) {
      log(`\n━━━ 进度: ${i + 1}/${count} ━━━`, 'info');

      const result = await registerAuto(browser, referralCode);
      if (result.success) {
        results.success.push(result);
      } else {
        results.failed.push(result);
      }

      // 间隔
      if (i < count - 1) {
        log(`等待 ${config.delay / 1000}s...`, 'wait');
        await delay(config.delay);
      }
    }
  } else {
    // ---- 手动模式：按批次 ----
    for (let i = 0; i < emails.length; i += config.maxConcurrentRequests) {
      const batch = emails.slice(i, i + config.maxConcurrentRequests);
      const batchNum = Math.floor(i / config.maxConcurrentRequests) + 1;
      const totalBatches = Math.ceil(emails.length / config.maxConcurrentRequests);

      log(`\n━━━ 批次 ${batchNum}/${totalBatches} ━━━`, 'info');

      // 手动模式串行（每个都要等用户输入验证码）
      for (const email of batch) {
        const result = await registerManual(browser, email, referralCode);
        if (result.success) {
          results.success.push(result);
        } else {
          results.failed.push(result);
        }
      }

      if (i + config.maxConcurrentRequests < emails.length) {
        log(`等待 ${config.delay / 1000}s...`, 'wait');
        await delay(config.delay);
      }
    }
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

  // 保存结果
  const report = {
    timestamp: new Date().toISOString(),
    mode: isAuto ? 'auto' : 'manual',
    total: count,
    success: results.success,
    failed: results.failed,
  };
  fs.writeFileSync('register_results.json', JSON.stringify(report, null, 2));
  log('结果已保存到 register_results.json', 'success');

  // 全自动模式额外保存账号信息
  if (isAuto && results.success.length > 0) {
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
