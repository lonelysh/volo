# MiniMax Assistant for Obsidian

> 在 Obsidian 中调用 MiniMax（MiniMax）国内版大模型：**侧边栏聊天 + 选中文本 AI 操作 + 整篇笔记处理**，兼容桌面端与 iOS。

## 功能

| 模块 | 入口 | 说明 |
|------|------|------|
| 侧边栏聊天 | Ribbon「消息气泡」图标，或命令 `MiniMax: 打开侧边栏聊天` | 流式输出，可注入当前笔记作为上下文 |
| 选中文本 AI 操作 | 编辑器菜单 / 命令面板 | 翻译（英↔中）、解释、总结、润色、口语化、自定义 Prompt |
| 整篇笔记命令 | 命令面板 | 总结当前笔记、生成大纲、续写、修正错别字 |
| API 连通性测试 | 设置面板或命令 `MiniMax: 测试 API 连通性` | 用当前配置发一次 1-token 请求 |

## 安装

### 方式 A：手动（推荐）
1. 从 Release 下载 `mmxob.zip` 或 `main.js` + `styles.css` + `manifest.json`。
2. 解压到你的 vault 的 `.obsidian/plugins/mmxob/`。
3. 在 Obsidian → 设置 → 第三方插件 → 已安装插件中启用 **MiniMax Assistant**。

### 方式 B：源码开发
```bash
git clone <repo>
cd mmxob
npm install
npm run dev        # 开发模式，自动 watch
npm run build      # 生产构建
```

### 方式 C：BRAT（iOS 测试）
把仓库地址加进 BRAT → "Add Beta plugin"，安装 `mmxob`。

## 快速开始

1. 打开设置 → 第三方插件 → **MiniMax Assistant**。
2. 在 **API Key** 输入在 [platform.minimaxi.com](https://platform.minimaxi.com) 创建的 Key。
3. **Base URL** 默认 `https://api.minimaxi.com/v1`，按需修改：
   - 海外站：`https://api.minimax.io/v1`
   - 自建/代理：填你自己的 URL
4. 选模型（推荐 `MiniMax-M3`）。
5. 点 **测试 API**，看到 "OK" 即配置完成。
6. 在右侧栏打开 Chat，或者选中一段文本试试"翻译为英文"。

## 关键字段速查

| 设置项 | 默认 | 说明 |
|--------|------|------|
| Base URL | `https://api.minimaxi.com/v1` | 国内站；与 API Key 必须同区 |
| 模型 | `MiniMax-M3` | 长上下文 + 工具调用 + 多模态 |
| Temperature | 0.7 | 0=确定，2=发散 |
| Max Tokens | 4096 | M3 上限 65536 |
| System Prompt | 内置中文提示 | 每次请求都带上 |
| 注入笔记上下文 | 开 | 新一轮对话自动把当前笔记拼入 system |

## iOS 兼容性说明

本插件在移动端做以下特别处理：

- `manifest.json` 中 `isDesktopOnly: false`，iOS / Android 均可见
- 触摸目标 ≥ 44×44px，符合 WCAG 与 iOS HIG
- `padding` 使用 `env(safe-area-inset-*)`，兼容刘海屏 / iPad 分屏
- 没有 `position: fixed` 作为主布局，没有 hover-only 交互
- 没有 `backdrop-filter` 影响 fixed 子元素
- 网络层首选 `fetch()` + AbortController（流式），失败时自动回退到 Obsidian `requestUrl()`（受 iOS CORS 保护，非流式兜底）
- 网络请求全部走 HTTPS
- 设置面板底部给 iOS 用户显示额外提示

## 错误码速查

| HTTP / 业务码 | 含义 | 用户动作 |
|---------------|------|----------|
| 401 / 1004 / 2049 | 鉴权失败 | 检查 API Key；检查 Base URL 是否与 Key 同区 |
| 1008 | 余额不足 | 充值 |
| 429 / 1002 / 1039 / 2045 / 2056 | 限流 | 等待重试；降频；调低 max_tokens |
| 1026 | 输入敏感 | 改写输入 |
| 1027 | 输出敏感 | 调整 prompt 或换种问法 |
| 500+ / 1013 / 1033 | 服务端错误 | 稍后重试 |
| iOS 流式失败 | CORS / 网络 | 自动回退到非流式 |

## 文件结构

```
mmxob/
├── manifest.json              # isDesktopOnly: false
├── package.json               # esbuild + typescript
├── tsconfig.json
├── esbuild.config.mjs
├── versions.json
├── styles.css                 # mobile-first, 44px, safe-area
└── src/
    ├── main.ts                # 入口、注册视图与命令
    ├── constants.ts           # 模型列表、默认 URL、预设操作
    ├── settings/
    │   ├── defaults.ts        # 默认配置
    │   └── SettingsTab.ts     # 设置 UI
    ├── api/
    │   ├── types.ts           # ChatMessage / Request / Response
    │   ├── errors.ts          # 错误归一化（含 1004/1008/1026/1027）
    │   ├── streaming.ts       # SSE 解析器
    │   └── client.ts          # MiniMaxClient（流式 + requestUrl 兜底）
    ├── views/
    │   └── ChatView.ts        # 侧边栏聊天视图
    ├── commands/
    │   ├── selection.ts       # 选中文本 AI 操作
    │   └── note.ts            # 整篇笔记处理
    └── utils/
        ├── markdown.ts        # （占位）Markdown 工具
        ├── mobile.ts          # Platform.isIosApp 工具
        └── prompt.ts          # 占位符模板、截断
```

## 开发脚本

```bash
npm run dev      # watch 模式
npm run build    # 类型检查 + 生产打包
npm run version  # bump 版本号（会同时更新 manifest.json 与 versions.json）
```

## 许可证

MIT