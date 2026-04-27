# Desktop Task Ball / 桌面任务球

桌面任务球是一个 **本地优先的个人自动化桌面应用**：把 `tasks/` 目录里的脚本包装成可配置任务，通过悬浮小球快速打开控制台、手动运行任务、查看日志、做 AI 分析，并在确实需要打扰用户时发出桌面通知。

本优化版完成了现代化界面重构、运行与通知逻辑修复、跨平台快捷命令支持、文档补齐和构建校验。

## 核心能力

- **悬浮小球**：固定在桌面边缘，点击显示/隐藏主控制台，右键执行快捷命令。
- **任务管理**：创建任务、上传脚本、定义参数 schema、设置标签筛选、配置超时/定时/重试/通知与 AI 提供方。
- **脚本库**：独立导航页集中处理脚本上传与下载，展示服务端脚本名称与 AI 生成简介。
- **脚本执行**：支持 `.py` / `.bat` / `.cmd` / `.ps1`，统一记录 `input.json`、命令行、stdout/stderr、退出码、耗时。
- **AI 分析**：成功后可调用 opencode 或 OpenAI 兼容接口；失败后可进行诊断分析。
- **智能通知**：AI 返回 `need_notify=true` 且任务启用通知时才弹通知，避免无意义打扰。
- **运行记录**：按任务过滤、搜索、分页、查看详情、重试 AI、批量删除、清理失败记录。
- **参数自动生成**：本地脚本优先做规则解析（`argparse/click/--flag`）；未识别时可调用 OpenAI 兼容接口自动补全 schema。
- **自动安装**：遇到 `ModuleNotFoundError` 时可通过 AI 建议 pip 包并尝试安装后重跑（安装前强制人工确认）。
- **运行稳定性**：支持运行中取消、同任务并发保护（运行中禁止重复启动）。
- **设置与运维**：Python 检测、opencode 状态、OpenAI 连接测试、脚本服务器配置、配置导入导出、健康检查。

## 技术栈

| 层级 | 技术 |
|---|---|
| 桌面壳 | Electron + electron-vite |
| 渲染层 | React + TypeScript + Tailwind CSS |
| 主进程 | Electron main process + IPC |
| 数据库 | sql.js / SQLite WASM |
| 执行器 | `child_process.spawn` |
| AI | opencode session API / OpenAI-compatible Chat Completions |
| 构建与测试 | TypeScript / Vite / Vitest |

## 安装与运行

```bash
npm install
npm run dev
```

构建与检查：

```bash
npm run typecheck
npm run build
```

开发模式下数据写入项目根目录下的 `data/` 与 `tasks/`；打包后写入 Electron `userData` 目录。

## 目录结构

```text
desktop-task-ball/
├── app/
│   ├── main/                  # Electron 主进程
│   ├── preload/index.ts       # contextBridge 安全暴露 API
│   ├── renderer/              # React UI
│   └── shared/types.ts        # 主/渲染共享类型
├── tasks/example.py           # 示例脚本
├── docs/PRODUCT_DOCUMENT.md   # 产品文档
└── package.json
```

## 首次使用建议

1. 打开 **设置**，确认 Python 路径可用。
2. 使用 **环境健康检查** 确认 Python、opencode 与脚本状态。
3. 在 **任务** 中新建任务，脚本可填写 `example.py` 或点击上传脚本。
4. 配置参数、标签、超时、定时、重试、AI 提供方和通知策略。
5. 保存后点击运行，在 **运行记录** 中查看日志、输出、AI 分析与通知状态。

## 编写脚本

脚本必须位于 `tasks/` 目录内，并使用支持后缀：`.py` / `.bat` / `.cmd` / `.ps1`。

任务参数会以两种方式提供：

1. 按参数 schema 转成命令行 flags，例如 `--url https://example.com --verbose`。
2. 写入运行目录的 `input.json`，路径通过环境变量 `TASK_BALL_INPUT_JSON` 提供；运行 ID 通过 `TASK_BALL_RUN_ID` 提供。

stdout 推荐输出 JSON；如果不是 JSON，应用会按纯文本保存并传给 AI 分析。

参数自动生成规则：

1. 任务编辑页支持“自动生成参数”按钮，并在上传脚本后自动触发一次。
2. 若本地规则可识别参数结构，直接生成 `argsSchema`。
3. 若规则未识别且未配置 OpenAI，返回开发者补全提示。
4. 若规则未识别且已配置 OpenAI，自动生成标准化参数结构。

## 脚本服务器（可选）

启用后可在“脚本库”页面上传/下载脚本：

1. 客户端在设置页开启脚本服务器，并填写 `scriptServerBaseUrl`。
2. 服务端采用 IP 白名单鉴权，上传后自动生成约 20 字简介。
3. 服务端会检测参数标准化；未标准化且 AI 可用时，返回 `argsSchema`。
4. 详细部署与接口见 [script-server/README.md](file:///c:/Users/maxiang/Desktop/desktop-task-ball/desktop-task-ball/script-server/README.md)。

## AI 输出契约

成功分析与失败诊断都应返回 JSON：

```json
{
  "run_id": "当前运行 ID",
  "summary": "一句话总结",
  "details": "Markdown 详情",
  "need_notify": false,
  "notify_title": "可选通知标题",
  "notify_body": "可选通知正文"
}
```

通知规则：`task.notifyEnabled === true` 且 `aiResult.need_notify === true`。

## 本次优化记录

- 重构主面板为现代侧边栏 + 内容区信息架构。
- 统一深色/浅色主题 token、卡片、按钮、输入框、标签、指标卡与滚动条样式。
- 优化任务列表、运行列表、运行详情、通知中心、设置页的布局与视觉层级。
- 修复 AI 通知忽略 `need_notify` 的问题。
- 修复重试 AI 时可能重复无意义通知的问题。
- 修复快捷命令 Windows-only 的问题，macOS/Linux 自动使用 `$SHELL` 或 `sh -lc`。
- 修复运行记录批量删除返回数量不准确的问题。
- 修复“一键删失败”可能误清当前选中运行详情的问题。
- 修复数字参数输入框清空后被错误转为 `0` 的问题。
- OpenAI 连接测试增加兼容 fallback：不支持 `response_format` 的网关会自动降级重试。
- 新增任务单标签与按标签筛选。
- 新增脚本库独立导航页（上传/下载 + 简介展示）。
- 新增本地参数自动生成（规则解析 + AI 兜底）。
- 新增服务端上传后参数标准化检测与 AI 补全返回。
- 新增运行取消与同任务并发保护。
- 补充 `tasks/example.py` 与完整产品文档。

## 已验证

- `npm install`
- `npm run typecheck`
- `npm run build`
- TypeScript / TSX parse check
- 个人工具精简验收清单：`docs/ACCEPTANCE_PERSONAL_TOOL.md`

说明：本环境执行 Electron 相关测试时，Electron 二进制下载受网络/DNS 限制；源码类型检查与生产构建已通过。
