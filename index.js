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
        checked: i.checked,
      }));
      const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]')).map(c => ({
        id: c.id,
        name: c.name,
        checked: c.checked,
        label: c.closest('label')?.textContent?.trim()?.substring(0, 80) || '',
        parentText: c.parentElement?.textContent?.trim()?.substring(0, 80) || '',
      }));
      return { url: location.href, title: document.title, buttons, inputs, checkboxes };
    });
    log(`页面: ${info.url}`, 'debug');
    log(`标题: ${info.title}`, 'debug');
    log(`按钮(${info.buttons.length}):`, 'debug');
    info.buttons.forEach((b, i) => log(`  [${i}] "${b.text}" type=${b.type} disabled=${b.disabled}`, 'debug'));
    log(`输入框(${info.inputs.length}):`, 'debug');
    info.inputs.forEach((inp, i) => log(`  [${i}] type=${inp.type} id=${inp.id} name=${inp.name} placeholder=${inp.placeholder} checked=${inp.checked}`, 'debug'));
    log(`复选框(${info.checkboxes.length}):`, 'debug');
    info.checkboxes.forEach((c, i) => log(`  [${i}] id=${c.id} checked=${c.checked} label="${c.label}" parent="${c.parentText}"`, 'debug'));
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
// 增强点击：真实鼠标事件 + JS 触发双保险
// ========================
async function robustClick(page, element) {
  await element.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await delay(300);

  const box = await element.boundingBox();
  if (box) {
    // 用真实鼠标坐标点击
    await page.mouse.click(
      box.x + box.width / 2,
      box.y + box.height / 2,
      { delay: 50 }
    );
    return true;
  }
  // 兜底：JS 触发
  await element.evaluate(el => {
    el.disabled = false;
    el.removeAttribute('disabled');
    el.click();
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  return true;
}

// ========================
// 勾选同意条款复选框（关键修复）
// ========================
async function agreeTerms(page) {
  log('查找并勾选同意条款复选框...', 'wait');

  await debugPageInfo(page);

  // 策略1: 查找并点击所有 checkbox（兼容 React/Vue 自定义组件）
  const result = await page.evaluate(() => {
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    let clicked = 0;
    const details = [];

    checkboxes.forEach((cb, i) => {
      const parentText = (cb.parentElement?.textContent || '').trim().substring(0, 100);
      const label = cb.closest('label')?.textContent?.trim()?.substring(0, 100) || '';
      details.push({ i, id: cb.id, name: cb.name, checked: cb.checked, parentText, label });

      if (!cb.checked) {
        // 先用原生 setter
        try {
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked').set;
          nativeSetter.call(cb, true);
        } catch {}
        // 再直接 click
        cb.click();
        // 触发事件
        cb.dispatchEvent(new Event('input', { bubbles: true }));
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        clicked++;
      }
    });

    return { clicked, details, totalCheckboxes: checkboxes.length };
  });

  log(`找到 ${result.totalCheckboxes} 个复选框，处理了 ${result.clicked} 个`, 'info');
  for (const d of result.details) {
    log(`  checkbox[${d.i}]: id=${d.id} checked=${d.checked} text="${d.parentText.substring(0, 50)}"`, 'debug');
  }

  // 策略2: 点击包含"已阅读并同意"的整个文字区域（可能是自定义 checkbox）
  const customCheckboxClicked = await page.evaluate(() => {
    // 找包含"已阅读"或"同意"的所有可见元素
    const allEls = document.querySelectorAll('*');
    let found = false;
    for (const el of allEls) {
      // 只检查直接包含文字的叶子节点
      if (el.children.length > 5) continue;
      const text = el.textContent || '';
      if ((text.includes('已阅读') || text.includes('本人已阅读')) && el.offsetParent !== null) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.width < 800) {
          el.click();
          // 也触发父元素
          if (el.parentElement) el.parentElement.click();
          found = true;
        }
      }
    }
    return found;
  });

  if (customCheckboxClicked) {
    log('点击了自定义复选框区域', 'info');
  }

  // 策略3: 用 Puppeteer 坐标点击包含同意文字的元素
  if (result.clicked === 0 && !customCheckboxClicked) {
    log('JS 策略未生效，尝试坐标点击...', 'warn');
    const agreementElements = await page.$x(
      '//*[contains(text(), "已阅读") or contains(text(), "同意") or contains(text(), "用户协议")]'
    );
    for (const el of agreementElements) {
      try {
        await robustClick(page, el);
        log('坐标点击了同意元素', 'info');
        await delay(300);
      } catch {}
    }

    // 兜底：点击所有 checkbox
    const cbs = await page.$$('input[type="checkbox"]');
    for (const cb of cbs) {
      try {
        const checked = await page.evaluate(el => el.checked, cb);
        if (!checked) {
          await robustClick(page, cb);
          log(`坐标点击了复选框`, 'info');
          await delay(200);
        }
      } catch {}
    }
  }

  await delay(1000);

  // 截图验证勾选状态
  await debugScreenshot(page, 'after_agree_terms');

  const verifyResult = await page.evaluate(() => {
    const cbs = document.querySelectorAll('input[type="checkbox"]');
    return Array.from(cbs).map(c => ({ id: c.id, checked: c.checked }));
  });
  log(`勾选验证: ${JSON.stringify(verifyResult)}`, 'debug');
}

// ========================
// 关闭可能弹出的下拉框/弹窗
// ========================
async function closeDropdowns(page) {
  await page.evaluate(() => {
    // 关闭语言选择等下拉框
    document.querySelectorAll('[class*="dropdown"], [class*="select"], [class*="popover"], [class*="popup"]').forEach(el => {
      if (el.classList.contains('open') || el.classList.contains('active') || el.classList.contains('show')) {
        el.classList.remove('open', 'active', 'show');
      }
    });
  });
  // 点击页面空白处关闭下拉
  await page.mouse.click(10, 10);
  await delay(500);
}

// ========================
// 输入邮箱并发送验证码（完整重写）
// ========================
async function inputEmailAndSendCode(page, email) {
  await delay(3000);

  // 先关闭可能的下拉框
  await closeDropdowns(page);

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

  // 输入邮箱 — 键盘操作触发 React onChange
  await emailInput.click();
  await delay(200);
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await delay(200);
  await emailInput.type(email, { delay: 30 });
  log(`已输入邮箱: ${email}`, 'info');

  // Tab 失焦触发验证
  await page.keyboard.press('Tab');
  await delay(500);

  // 额外触发 React 事件
  await page.evaluate(el => {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
    nativeInputValueSetter.call(el, el.value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }, emailInput);

  await delay(1000);

  // ★★★ 关键修复：先勾选同意条款，再点发送 ★★★
  await agreeTerms(page);
  await delay(1000);

  // 再次关闭可能的下拉
  await closeDropdowns(page);
  await delay(500);

  log('等待发送按钮变为可用...', 'wait');

  // 等待按钮出现并可用
  let sendBtn = null;
  for (let i = 0; i < 30; i++) {
    await delay(500);

    const btnHandle = await page.evaluateHandle(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = btn.textContent || '';
        if (text.includes('发送验证信') || text.includes('发送验证码') || text.includes('Send')) {
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

  // 如果按钮仍是 disabled，强制移除
  if (!sendBtn) {
    log('按钮未自动变为可用，尝试强制启用...', 'warn');
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
    throw new Error('找不到发送验证码按钮');
  }

  // 获取按钮位置
  await sendBtn.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await delay(500);

  const urlBefore = page.url();
  const btnBox = await sendBtn.boundingBox();

  if (!btnBox) {
    throw new Error('无法获取按钮位置');
  }

  const cx = btnBox.x + btnBox.width / 2;
  const cy = btnBox.y + btnBox.height / 2;

  // ★★★ 六连击策略：确保按钮被触发 ★★★

  // 策略1: 完整鼠标事件链（mousedown → mouseup → click）
  log('策略1: 完整鼠标事件链点击...', 'debug');
  await page.mouse.move(cx, cy, { steps: 5 });
  await delay(100);
  await page.mouse.down();
  await delay(80);
  await page.mouse.up();
  await delay(500);

  // 等一下检查是否生效
  await delay(2000);
  let btnGone = !(await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('发送验证信'));
  }).catch(() => true));

  if (!btnGone) {
    // 策略2: 直接触发 React onClick 内部处理器
    log('策略2: 查找React onClick处理器并触发...', 'debug');
    await page.evaluate(() => {
      const findReactFiber = (dom) => {
        const key = Object.keys(dom).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$') || k.startsWith('__reactProps$'));
        return key ? dom[key] : null;
      };

      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent.includes('发送验证信') || btn.textContent.includes('发送验证码')) {
          btn.disabled = false;
          btn.removeAttribute('disabled');

          // 尝试找到 React props 中的 onClick
          const fiber = findReactFiber(btn);
          if (fiber) {
            // React 18+ : __reactProps$xxx
            if (fiber.onClick) {
              fiber.onClick({ preventDefault: () => {}, stopPropagation: () => {} });
              return;
            }
            // 遍历 fiber 链找 onClick
            let current = fiber;
            for (let i = 0; i < 10 && current; i++) {
              if (current.memoizedProps?.onClick) {
                current.memoizedProps.onClick({ preventDefault: () => {}, stopPropagation: () => {} });
                return;
              }
              if (current.pendingProps?.onClick) {
                current.pendingProps.onClick({ preventDefault: () => {}, stopPropagation: () => {} });
                return;
              }
              current = current.return;
            }
          }

          // 兜底：dispatch 全套事件
          const rect = btn.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const eventOpts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
          ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
            btn.dispatchEvent(new PointerEvent(type, eventOpts));
          });
        }
      }
    });
    await delay(2000);
  }

  // 检查是否生效
  btnGone = !(await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('发送验证信'));
  }).catch(() => true));

  if (!btnGone) {
    // 策略3: 找到父级 form 直接 submit
    log('策略3: 尝试提交表单...', 'debug');
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent.includes('发送验证信') || btn.textContent.includes('发送验证码')) {
          const form = btn.closest('form');
          if (form) {
            form.requestSubmit ? form.requestSubmit() : form.submit();
            return;
          }
        }
      }
      // 没有 form，尝试找最近的可提交元素
      const form = document.querySelector('form');
      if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
    });
    await delay(2000);
  }

  // 策略4: 再用 page.click（Playwright 风格更精确）
  if (!btnGone) {
    btnGone = !(await page.evaluate(() => {
      return Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('发送验证信'));
    }).catch(() => true));
  }

  if (!btnGone) {
    log('策略4: 再次鼠标点击（双击）...', 'debug');
    await page.mouse.click(cx, cy, { clickCount: 2, delay: 100 });
    await delay(2000);
  }

  // 等待页面响应 — 检测验证码输入框或 URL 变化
  log('等待页面响应...', 'wait');
  await delay(3000);

  const urlAfter = page.url();
  if (urlBefore !== urlAfter) log(`URL变化: ${urlBefore} → ${urlAfter}`, 'info');

  // 等待验证码输入框出现
  const codeSelectors = [
    'input[type="tel"]', 'input[type="number"]', 'input[inputmode="numeric"]',
    'input[maxlength="1"]', 'input[maxlength="6"]', 'input[maxlength="4"]',
    'input[id*="code" i]', 'input[name*="code" i]',
    'input[placeholder*="验证码" i]', 'input[placeholder*="code" i]',
  ];

  let codeInputFound = false;
  for (const sel of codeSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 8000, visible: true });
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
      codeInputFound = true;
    } catch {}
  }

  // 最终检查
  const btnStill = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('发送验证信'));
  }).catch(() => false);

  if (btnStill && !codeInputFound) {
    log('⚠️ 所有点击策略均未生效，打印页面详情...', 'warn');
    await debugScreenshot(page, 'all_clicks_failed');
    await debugPageInfo(page);

    // 打印按钮的所有属性和父元素
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent.includes('发送验证信') || btn.textContent.includes('发送验证码')) {
          console.log('=== SEND BUTTON DEBUG ===');
          console.log('outerHTML:', btn.outerHTML);
          console.log('disabled:', btn.disabled);
          console.log('type:', btn.type);
          console.log('form:', btn.form ? btn.form.outerHTML.substring(0, 200) : 'no form');
          console.log('parent:', btn.parentElement?.outerHTML?.substring(0, 200));
          console.log('getEventListeners:', typeof getEventListeners !== 'undefined' ? getEventListeners(btn) : 'N/A');
          // 检查所有祖先的 pointer-events
          let el = btn;
          while (el) {
            const style = window.getComputedStyle(el);
            if (style.pointerEvents === 'none') {
              console.log('NONE pointer-events found on:', el.tagName, el.className);
            }
            el = el.parentElement;
          }
        }
      }
    });
  }

  if (!btnStill && !codeInputFound) {
    log('按钮消失了但没跳转，等待中...', 'wait');
    await delay(5000);
  }

  await debugScreenshot(page, 'after_send_code');
}

// ========================
// 输入验证码
// ========================
async function inputVerificationCode(page, code) {
  await delay(1000);

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
    for (let i = 0; i < 6; i++) {
      await inputs[i].click();
      await delay(100);
      await inputs[i].type(code[i], { delay: 30 });
    }
    log('已输入验证码（6个独立框）', 'info');
  } else if (inputs.length >= 1) {
    await inputs[0].click({ clickCount: 3 });
    await delay(100);
    await inputs[0].type(code, { delay: 80 });
    log('已输入验证码（单框）', 'info');
  } else {
    await page.keyboard.type(code, { delay: 80 });
    log('已通过键盘输入验证码', 'info');
  }

  await page.keyboard.press('Tab');
  await delay(1000);

  // 点击确认/下一步
  await clickNextButton(page);
  await delay(2000);
}

// ========================
// 通用下一步按钮点击
// ========================
async function clickNextButton(page) {
  const buttonTexts = [
    '下一步', '确认', '提交', '完成', '注册', '注册完成', '继续',
    'Next', 'Submit', 'Confirm', 'Continue', 'Register',
    '다음', '확인', '가입하기',
  ];

  for (const text of buttonTexts) {
    try {
      const btns = await page.$x(`//button[contains(translate(text(), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "${text.toLowerCase()}")]`);
      for (const btn of btns) {
        const isVisible = await page.evaluate(el => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' &&
                 !el.disabled && rect.width > 0 && rect.height > 0;
        }, btn).catch(() => false);

        if (isVisible) {
          await robustClick(page, btn);
          log(`点击按钮: "${text}"`, 'info');
          return true;
        }
      }
    } catch {}
  }

  // CSS 兜底
  const submitBtn = await page.$('button[type="submit"]:not([disabled])');
  if (submitBtn) {
    await robustClick(page, submitBtn);
    log('点击 submit 按钮', 'info');
    return true;
  }

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
  await clickNextButton(page);
  await delay(2000);

  // 同意条款（密码页面后的第二步）
  log('同意条款...', 'wait');

  // 再次勾选所有 checkbox
  await page.evaluate(() => {
    document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      if (!cb.checked) {
        cb.click();
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  });

  // 也尝试点击包含"同意"的 label
  const agreeLabels = await page.$x('//label[contains(text(), "同意") or contains(text(), "agree")]');
  for (const label of agreeLabels) {
    try { await robustClick(page, label); } catch {}
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
    await delay(3000);

    await debugScreenshot(page, 'page_loaded');

    // 步骤1: 输入邮箱 + 勾选条款 + 发送验证码
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
║     v1.4 — 修复同意条款+发送按钮    ║
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
        // Chrome 优先（Edge 跟踪防护会导致 401）
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        // Edge 备选
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
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
