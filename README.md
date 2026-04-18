# NOL World 批量注册工具

自动批量注册 [NOL World](https://world.nol.com) 账户，支持3种模式。

## 注册模式

| 模式 | 说明 | 验证码 | 适合 |
|------|------|--------|------|
| 🤖 全自动 | mail.tm 临时创建 | 自动获取 | 批量注册 |
| 📧 手动 | email.txt 预设 | 手动输入 | 用自己的邮箱 |
| 📬 **Gmail** | Gmail + 别名自动创建 | **自动获取** | 稳定批量注册 |

## 功能特性

- 🔄 **失败自动重试** — 可配置重试次数
- 🎲 **随机延迟** — 每次间隔随机波动 ±30%
- 💾 **断点续传** — 程序崩溃后可继续
- 🔀 **User-Agent 轮换** — 每次不同浏览器指纹
- 🖥️ **运行时选 headless** — 可选后台运行

## 快速开始

```bash
npm install
cp config.local.js.example config.local.js
# 编辑 config.local.js 填入配置
npm start
```

## Gmail 模式原理

利用 Gmail `+` 别名，一个 Gmail 生成无限邮箱：
```
你的真实邮箱:  gji24408@gmail.com
别名邮箱:      gji24408+nol_abc123@gmail.com  → 邮件发到同一个收件箱
```

### Gmail 设置
1. 开启 IMAP: https://mail.google.com/mail/u/0/#settings/fwdandpop
2. 生成应用专用密码: https://myaccount.google.com/apppasswords
