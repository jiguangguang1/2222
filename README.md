# NOL World 批量注册工具

自动批量注册 [NOL World](https://world.nol.com) 账户，支持**全自动**和**手动**两种模式。

## 两种模式

| | 🤖 全自动模式 | 📧 手动模式 |
|---|---|---|
| 邮箱来源 | mail.tm 临时创建 | email.txt 预设 |
| 验证码 | 自动获取，无需人工 | 需要手动输入 |
| 速度 | 每个约 30-60s | 取决于你查邮件的速度 |
| 适合 | 批量注册 | 用自己的邮箱注册 |

## 快速开始

### 1. 安装依赖

```bash
cd nol-auto-register
npm install
```

### 2. 配置参数

编辑 `config.js`：

```javascript
module.exports = {
  password: "YourPass123!",   // 8+位，含英文/数字/特殊符号至少2种
  delay: 5000,                // 每个注册之间的间隔（毫秒）
  headless: false,            // false=显示浏览器
  defaultReferralCode: "",    // 邀请码
  nicknamePrefix: "user",     // 昵称前缀
  verificationTimeout: 300000,// 验证码等待超时（全自动模式用）
};
```

### 3. 运行

```bash
node index.js
```

启动后选择模式：
- **输入 1** → 全自动（自动创建临时邮箱 + 自动收验证码）
- **输入 2** → 手动模式（用 email.txt 的邮箱，手动输入验证码）

## 全自动模式工作流程

```
mail.tm 创建临时邮箱
    ↓
用临时邮箱访问 NOL World 注册页
    ↓
输入邮箱 → 发送验证码
    ↓
自动轮询 mail.tm 收件箱 → 提取6位验证码
    ↓
自动输入验证码 → 设置密码 → 同意条款 → 设置昵称
    ↓
注册完成 → 保存账号到 accounts.txt
    ↓
创建下一个临时邮箱 → 重复...
```

## 文件结构

```
nol-auto-register/
├── index.js                # 主程序（两种模式）
├── tempmail.js             # mail.tm 临时邮箱模块
├── config.js               # 配置
├── email.txt               # 手动模式的邮箱列表
├── package.json
├── accounts.txt            # [自动生成] 账号信息（全自动模式）
├── register_results.json   # [自动生成] 注册结果报告
└── error_*.png             # [自动生成] 失败时的截图
```

## 验证码提取逻辑

`tempmail.js` 的 `extractCode()` 会从邮件内容中匹配6位数字：

1. 优先匹配带上下文的验证码（如 "验证码：123456"）
2. 退而匹配 HTML 中的 `<span>123456</span>`
3. 最后匹配任意6位连续数字（排除年份、全相同数字等）

## 注意事项

- **mail.tm 免费额度** — 每个 IP 可创建多个临时邮箱，但有频率限制
- **反检测** — 已移除 webdriver 标记，使用真实 Chrome 特征
- **密码要求** — NOL World 要求 8+ 位，英文+数字+特殊符号至少2种（如 `TestPass123!`）
- **注册间隔** — 建议 `delay` 设 5000ms 以上，太快容易被限流
- **错误处理** — 失败自动截图到 `error_*.png`，方便排查

## 常见问题

**Q: mail.tm 域名会不会被 NOL World 拒绝？**
A: 有可能。如果被拒，可以换其他临时邮箱服务（如 tempmail.plus、emailnator），改 `tempmail.js` 即可。

**Q: 可以用自己的邮箱吗？**
A: 可以，选手动模式，在 `email.txt` 里写你的邮箱。

**Q: 验证码邮件一直没到？**
A: 默认等5分钟。mail.tm 偶尔慢，可以加到 600000（10分钟）。

**Q: 能改成 headless 后台运行吗？**
A: 配置里 `headless: "new"` 即可（Chrome 新无头模式）。
