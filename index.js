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
  const icons = { info: 'ℹ️', success: '✅', error: '❌', warn: '⚠️', wait: '⏳', retry: '🔄', debug: '🔍' };
  const colors = { info: '\x1b[36m', success: '\x1b[32m', error: '\x1b[31m', warn: '\x1b[33m', wait: '\x1b[35m', retry: '\x1b[33m', debug: '\x1b[90m' };
  const reset = '\x1b[0m';
  console.log(`${colors[type] || ''}${icons[type] || ''} ${msg}${reset}`);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

// 调试截图
async function debugScreenshot(page, label) {
  const path = `debug_${label}_${Date.now()}.png`;
  await page.screenshot({ path, fullPage: true }).catch(() => {});
  log(`调试截图: ${path}`, 'debug');
  return path;
}

// 打印当前页面信息（调试用）
async function debugPageInfo(page) {
  try {
    const info = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button')).map(b => ({
        text: b.textContent.trim().substring(0, 50),
        type: b.type,
        disabled: b.disabled,
        className: b.className.substring(0, 80),
      }));
      const inputs = Array.from(document.querySelectorAll('input')).map(i => ({
        type: i.type,
        id: i.id,
        name: i.name,
        placeholder: i.placeholder,
      }));
      return { url: location.href, title: document.title, buttons, inputs };
    });
    log(`页面: ${info.url}`, 'debug');
    log(`标题: ${info.title}`, 'debug');
    log(`按钮(${info.buttons.length}):`, 'debug');
    info.buttons.forEach((b, i) => log(`  [${i}] "${b.text}" type=${b.type} disabled=${b.disabled}`, 'debug'));
    log(`输入框(${info.inputs.length}):`, 'debug');
    info.inputs.forEach((inp, i) => log(`  [${i}] type=${inp.type} id=${inp.id} name=${inp.name} placeholder=${inp.placeholder}`, 'debug'));
  } catch (e) {
    log(`获取页面信息失败: ${e.message}`, 'debug');
  }
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
// 点击按钮（增强版，多策略）
// ========================
async function clickButton(page, buttonName = 'next') {
  // 策略1: 按钮文字匹配
  const buttonTexts = [
    '发送验证码', '获取验证码', '发送', '获取',
    'Send Code', 'Get Code', 'Send', 'Get',
    '下一步', '确认', '提交', '完成', '注册', '注册完成',
    '다음', '확인', '가입하기',
    'Next', 'Submit', 'Confirm', 'Continue', 'Register',
  ];

  for (const text of buttonTexts) {
    try {
      const btn = await page.$x(`//button[contains(translate(text(), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "${text.toLowerCase()}")] | //a[contains(translate(text(), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "${text.toLowerCase()}")]`);
      if (btn.length > 0) {
        // 检查是否可见且未禁用
        const isVisible = await page.evaluate(el => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
        }, btn[0]).catch(() => false);

        if (isVisible) {
          await btn[0].evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
          await delay(200);
          await btn[0].click();
          log(`点击按钮: "${text}"`, 'info');
          return true;
        }
      }
    } catch {}
  }

  // 策略2: CSS 选择器
  const cssSelectors = [
    'button:not([disabled])',
    'a[class*="btn"]',
    'div[class*="btn"]:not([disabled])',
    'span[class*="btn"]',
    '[role="button"]:not([disabled])',
  ];

  for (const sel of cssSelectors) {
    try {
      const elements = await page.$$(sel);
      for (const el of elements) {
        const isClickable = await page.evaluate(el => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' &&
                 !el.disabled && rect.width > 0 && rect.height > 0;
        }, el).catch(() => false);

        if (isClickable) {
          await el.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
          await delay(200);
          await el.click();
          log(`点击元素: ${sel}`, 'info');
          return true;
        }
      }
    } catch {}
  }

  // 策略3: submit 按钮
  try {
    const submitBtn = await page.$('button[type="submit"]:not([disabled])');
    if (submitBtn) {
      await submitBtn.evaluate(el => el.scrollIntoView({ block: 'center' }));
      await delay(300);
      await submitBtn.click();
      log('点击 submit 按钮', 'info');
      return true;
    }
  } catch {}

  return false;
}

// ========================
// 公共注册流程（密码 + 条款 + 昵称）
// ========================

async function completeRegistration(page, email, nickname) {
  await delay(3000);
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
  await delay(1000);

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
  } else {
    log('未找到密码输入框，跳过密码设置', 'warn');
  }

  await delay(500);
  await clickButton(page, 'next');
  await delay(2000);

  // 同意条款
  log('同意条款...', 'wait');

  const allAgreeSelectors = [
    'input[type="checkbox"]#all',
    'input[type="checkbox"][data-testid*="all"]',
    'input[type="checkbox"][id*="all"]',
    'input[type="checkbox"][name*="all"]',
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
  await clickButton(page, 'next');
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
  await clickButton(page, 'next');
  await delay(3000);

  return nickname;
}

// ========================
// 输入邮箱并发送验证码（核心修复）
// ========================

async function inputEmailAndSendCode(page, email) {
  await delay(3000);

  // 查找邮箱输入框
  const emailSelectors = [
    'input[type="email"]',
    'input[id*="email" i]',
    'input[name*="email" i]',
    'input[placeholder*="email" i]',
    'input[placeholder*="邮箱" i]',
    'input[autoComplete="email"]',
    'input[autocomplete="email"]',
  ];

  let emailInput = null;
  for (const sel of emailSelectors) {
    try {
      emailInput = await page.waitForSelector(sel, { timeout: 3000, visible: true });
      if (emailInput) {
        log(`找到邮箱输入框: ${sel}`, 'debug');
        break;
      }
    } catch {}
  }

  if (!emailInput) {
    await debugScreenshot(page, 'no_email_input');
    await debugPageInfo(page);
    throw new Error('找不到邮箱输入框');
  }

  // 输入邮箱 — 用 Puppeteer 原生键盘操作，让 React 正确响应
  // 不能用 el.value = ''，会破坏 React 内部状态
  await emailInput.click();           // 聚焦
  await delay(200);
  await page.keyboard.down('Control');
  await page.keyboard.press('A');     // Ctrl+A 全选
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace'); // 删除已有内容
  await delay(200);
  await emailInput.type(email, { delay: 30 }); // 逐字符输入，触发 React onChange
  log(`已输入邮箱: ${email}`, 'info');

  // 按 Tab 失焦，触发邮箱格式验证
  await page.keyboard.press('Tab');
  await delay(500);

  // 额外触发 React 兼容的 InputEvent（某些 React 版本需要）
  await page.evaluate(el => {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
    nativeInputValueSetter.call(el, el.value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }, emailInput);

  log('等待按钮变为可用...', 'wait');

  // 等待按钮出现并可用（通过文字精准匹配）
  // 按钮: <button type="submit" ... disabled="">发送验证信至电子邮箱</button>
  let sendBtn = null;
  for (let i = 0; i < 30; i++) {
    await delay(500);

    // 通过 evaluate 在页面中精确查找包含 "发送验证信" 的按钮
    const btnHandle = await page.evaluateHandle(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent.includes('发送验证信') || btn.textContent.includes('发送验证码') || btn.textContent.includes('Send')) {
          return btn;
        }
      }
      return null;
    });

    const el = btnHandle.asElement();
    if (el) {
      const isDisabled = await page.evaluate(b => b.disabled, el).catch(() => true);
      const btnText = await page.evaluate(b => b.textContent.trim(), el).catch(() => '');

      if (i % 5 === 0) {
        log(`找到按钮: "${btnText}" disabled=${isDisabled}`, 'debug');
      }

      if (!isDisabled) {
        sendBtn = el;
        log(`按钮已可用: "${btnText}"`, 'success');
        break;
      }
    }
  }

  // 如果按钮仍然是 disabled，强制移除
  if (!sendBtn) {
    log('按钮未自动变为可用，尝试强制点击...', 'warn');
    sendBtn = await page.evaluateHandle(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent.includes('发送验证信') || btn.textContent.includes('发送验证码')) {
          btn.disabled = false;
          btn.removeAttribute('disabled');
          return btn;
        }
      }
      return null;
    }).then(h => h.asElement()).catch(() => null);
  }

  if (!sendBtn) {
    await debugScreenshot(page, 'no_send_btn');
    await debugPageInfo(page);
    throw new Error('找不到"发送验证信至电子邮箱"按钮');
  }

  // 点击按钮 — 用 page.click 模拟真实鼠标事件
  await sendBtn.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await delay(300);

  const urlBefore = page.url();

  // 获取按钮位置，用 page.click 发送真实鼠标事件
  const btnBox = await sendBtn.boundingBox();
  if (btnBox) {
    await page.mouse.click(
      btnBox.x + btnBox.width / 2,
      btnBox.y + btnBox.height / 2,
      { delay: 50 }
    );
    log('已通过鼠标点击发送验证码按钮', 'success');
  } else {
    // 兜底：移除 disabled 后用 evaluate 触发
    await page.evaluate(el => { el.disabled = false; el.removeAttribute('disabled'); }, sendBtn);
    await sendBtn.click();
    log('已通过JS点击发送验证码按钮（兜底）', 'success');
  }

  // 等待页面变化（SPA 可能不会触发 navigation 事件）
  await delay(3000);

  // 检测 URL 变化
  const urlAfter = page.url();
  if (urlBefore !== urlAfter) log(`URL变化: ${urlAfter}`, 'info');

  // 等待验证码输入框出现（说明页面已切换到验证码步骤）
  const codeSelectors = [
    'input[type="tel"]', 'input[type="number"]', 'input[inputmode="numeric"]',
    'input[maxlength="1"]', 'input[maxlength="6"]', 'input[maxlength="4"]',
    'input[id*="code" i]', 'input[name*="code" i]',
    'input[placeholder*="验证码" i]', 'input[placeholder*="code" i]',
  ];

  let codeInputFound = false;
  for (const sel of codeSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 5000, visible: true });
      log(`检测到验证码输入框: ${sel}`, 'success');
      codeInputFound = true;
      break;
    } catch {}
  }

  // 备选：等待传统导航
  if (!codeInputFound) {
    try {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 });
      log('页面已跳转', 'info');
    } catch {}
  }

  // 检查按钮是否还在（可能点击没生效）
  if (!codeInputFound) {
    const btnStill = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('发送验证信'));
    }).catch(() => false);
    if (btnStill) log('警告: 发送按钮仍然存在，可能未生效', 'warn');
  }

  await debugScreenshot(page, 'after_send_code');
}

// ========================
// 输入验证码
// ========================

async function inputVerificationCode(page, code) {
  // 等待验证码输入区域出现
  await delay(1000);

  // 尝试多种输入框选择器
  const selectors = [
    'input[type="tel"]',
    'input[type="number"]',
    'input[inputmode="numeric"]',
    'input[maxlength="1"]',
    'input[maxlength="6"]',
    'input[maxlength="4"]',
    'input[id*="code" i]',
    'input[name*="code" i]',
    'input[placeholder*="验证码" i]',
    'input[placeholder*="code" i]',
  ];

  let inputs = [];
  for (const sel of selectors) {
    try {
      inputs = await page.$$(sel);
      if (inputs.length > 0) {
        log(`找到验证码输入框: ${sel} (${inputs.length}个)`, 'debug');
        break;
      }
    } catch {}
  }

  if (inputs.length >= 6) {
    // 6个单独的输入框（每位一个）
    for (let i = 0; i < 6; i++) {
      await inputs[i].click();
      await delay(100);
      await inputs[i].type(code[i], { delay: 30 });
    }
    log('已输入验证码（6个独立框）', 'info');
  } else if (inputs.length >= 1) {
    // 单个输入框，输入完整验证码
    await inputs[0].click({ clickCount: 3 });
    await delay(100);
    await inputs[0].type(code, { delay: 80 });
    log('已输入验证码（单框）', 'info');
  } else {
    // 回退到键盘输入
    await page.keyboard.type(code, { delay: 80 });
    log('已通过键盘输入验证码', 'info');
  }

  // 输入完成后按 Tab 或点击其他地方触发验证
  await page.keyboard.press('Tab');
  await delay(1000);

  // 点击确认/下一步按钮
  await clickButton(page, 'confirm');
  await delay(2000);
}

// ========================
// 核心注册函数
// ========================

async function doRegister(browser, mode, email, referralCode, gmailInbox) {
  const page = await browser.newPage();
  await page.setUserAgent(randomUA());
  await page.setViewport({ width: 1280, height: 800 });

  // 反检测
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

    log('打开注册页面...', 'wait');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: config.pageTimeout });
    await delay(3000); // 额外等 SPA 渲染

    // 截图确认页面加载
    await debugScreenshot(page, 'page_loaded');

    // 步骤1: 输入邮箱 + 发送验证码
    await inputEmailAndSendCode(page, finalEmail);

    // 步骤2: 获取验证码
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

    // 步骤3: 输入验证码
    await inputVerificationCode(page, code);

    // 步骤4: 等待跳转到密码设置页面
    await delay(2000);
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    await delay(2000);

    // 步骤5: 设置密码 + 同意条款 + 设置昵称
    const nickname = await completeRegistration(page, finalEmail, null);

    log(`✅ 注册成功: ${finalEmail}`, 'success');
    return { success: true, email: finalEmail, password: config.password, nickname, url: page.url() };

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

  return { success: false, email, error: `重试 ${maxRetries} 次后仍失败` };
}

// ========================
// 主流程
// ========================

async function main() {
  console.log(`
╔══════════════════════════════════════╗
║     NOL World 账户批量注册工具       ║
║     v1.3 — 修复按钮点击 + 调试截图   ║
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
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ];
      for (const p of paths) { try { if (fs.existsSync(p)) return p; } catch {} }
      return undefined;
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

  if (results.success.length > 0) {
    const accounts = results.success.map(r => `${r.email}|${r.password || config.password}|${r.nickname || ''}`).join('\n');
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
