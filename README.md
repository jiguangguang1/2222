# NOL World 批量注册工具

自动批量注册 [NOL World](https://world.nol.com) 账户，支持3种模式。

## 注册模式

| 模式 | 说明 | 验证码 | 适合 |
|------|------|--------|------|
| 🤖 全自动 | mail.tm 临时创建 | 自动获取 | 批量注册 |
| 📧 手动 | email.txt 预设 | 手动输入 | 用自己的邮箱 |
| 📬 **Gmail** | Gmail + 别名自动创建 | **自动获取** | 稳定批量注册 |

## 快速开始

```bash
cd nol-auto-register
npm install
```

## Gmail 模式配置

### 1. 生成 Gmail 应用专用密码

1. 前往 https://myaccount.google.com/apppasswords
2. 选择「邮件」+「其他（自定义名称）」
3. 生成16位密码，填入 config.js

### 2. 创建 config.local.js

```bash
# 复制模板并编辑
cp config.local.js.example config.local.js
```

填入你的信息：
```js
module.exports = {
  password: "YourPass123!",
  gmail: {
    user: "yourname@gmail.com",
    appPassword: "abcd efgh ijkl mnop",
  },
};
```

### 3. 运行

```bash
npm start
# 选择模式 3 (Gmail 模式)
```

## 配置说明

```js
module.exports = {
  password: "TestPass123!",           // 注册密码（8+位，至少含2种字符类型）
  delay: 5000,                        // 每个注册间隔（毫秒）
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

程序自动：
1. 生成随机 Gmail 别名
2. 用别名注册 NOL World
3. 通过 IMAP 连接你的 Gmail 收件箱
4. 自动提取验证码邮件中的6位数字

## 项目结构

```
nol-auto-register/
├── index.js              # 主程序（3种模式）
├── gmail.js              # Gmail IMAP 自动收验证码模块
├── tempmail.js           # mail.tm 临时邮箱模块
├── config.js             # 配置
├── email.txt             # 手动模式的邮箱列表
├── package.json
├── accounts.txt          # [自动生成] 账号信息
├── register_results.json # [自动生成] 注册结果报告
└── error_*.png           # [自动生成] 失败时的截图
```

## 注意事项

- Gmail 应用专用密码不是你的 Google 账号密码，是独立的16位密码
- 建议使用全新的 Gmail 账号，避免影响主邮箱
- 注册间隔建议 5000ms 以上，太快可能被限流
- 失败截图保存在项目目录，方便排查问题
