# NOL World 批量注册工具

自动批量注册 [NOL World](https://world.nol.com) 账户，支持3种模式。

## 注册模式

| 模式 | 说明 | 验证码 | 适合 |
|------|------|--------|------|
| 🤖 全自动 | mail.tm 临时创建 | 自动获取 | 批量注册 |
| 📧 手动 | email.txt 预设 | 手动输入 | 用自己的邮箱 |
| 📬 **Gmail** | Gmail + 别名自动创建 | **自动获取** | 稳定批量注册 |

## 功能特性

- 🔄 **失败自动重试** — 可配置重试次数，失败后自动重试
- 🎲 **随机延迟** — 每次间隔随机波动 ±30%，降低被检测风险
- 💾 **断点续传** — 程序崩溃后可从上次进度继续
- 🔀 **User-Agent 轮换** — 每次使用不同的浏览器指纹
- 🖥️ **运行时选 headless** — 启动时可选后台运行
- ⏱️ **耗时统计** — 实时显示进度、成功率、已耗时间

## 快速开始

```bash
cd nol-auto-register
npm install

# 复制配置模板
cp config.local.js.example config.local.js   # Linux/Mac
copy config.local.js.example config.local.js  # Windows
```

编辑 `config.local.js`，填入你的信息：
```js
module.exports = {
  password: "YourPass123!",
  gmail: {
    user: "yourname@gmail.com",
    appPassword: "abcd efgh ijkl mnop",
  },
};
```

```bash
npm start
# 选择模式 3 (Gmail 模式)
```

## 配置说明

```js
module.exports = {
  password: "TestPass123!",           // 注册密码（8+位，至少含2种字符类型）
  delay: 5000,                        // 每个注册间隔（毫秒）
  maxRetries: 2,                      // 失败重试次数
  headless: false,                    // false=显示浏览器
  defaultReferralCode: "",            // 邀请码
  nicknamePrefix: "user",             // 昵称前缀
  verificationTimeout: 300000,        // 验证码超时（毫秒）
};
```

## Gmail 模式原理

利用 Gmail 的 `+` 别名功能，一个 Gmail 账号可以生成无限邮箱地址：

```
你的真实邮箱:  gji24408@gmail.com
别名邮箱1:     gji24408+nol_abc123@gmail.com  → 邮件发到同一个收件箱
别名邮箱2:     gji24408+nol_def456@gmail.com  → 邮件发到同一个收件箱
```

### Gmail 设置

1. 开启 IMAP: https://mail.google.com/mail/u/0/#settings/fwdandpop → 启用 IMAP
2. 生成应用专用密码: https://myaccount.google.com/apppasswords

## 项目结构

```
nol-auto-register/
├── index.js              # 主程序（3种模式 + 重试 + 断点续传）
├── gmail.js              # Gmail IMAP 自动收验证码模块
├── tempmail.js           # mail.tm 临时邮箱模块
├── config.js             # 默认配置
├── config.local.js       # 本地配置（不进 git）
├── config.local.js.example # 配置模板
├── email.txt             # 手动模式的邮箱列表
├── package.json
├── .gitignore
├── progress.json         # [自动生成] 断点续传进度
├── accounts.txt          # [自动生成] 注册成功的账号
├── register_results.json # [自动生成] 注册结果报告
└── error_*.png           # [自动生成] 失败时的截图
```

## 注意事项

- Gmail 应用专用密码不是你的 Google 账号密码，是独立的16位密码
- 建议使用全新的 Gmail 账号，避免影响主邮箱
- 注册间隔建议 5000ms 以上，太快可能被限流
- 断点续传文件 `progress.json` 在全部完成后自动删除
