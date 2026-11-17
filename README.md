# Chibi Desktop Pet — Q版智能互动桌宠

一个住在 Windows 桌面上的 Q 版角色：会自己走动、眨眼、睡觉，可以被鼠标抓起来、摸头、聊天，
接入 DeepSeek 等模型后还能**真正操作电脑**：管理文件、打开程序、操作窗口和浏览器、运行开发命令。
有风险的操作都会先问你（详见 [智能体说明](docs/AGENT.md)）。
技术栈：Electron + React + TypeScript + Vite + Zustand + PixiJS。

## 怎么运行

**不装任何东西**：打开 `ChibiDesktopPet-app` 文件夹，双击 `Chibi Desktop Pet.exe`。

**开发模式**（需要 Node.js 20+）：

```bash
npm install
npm run dev        # 热更新开发
npm start          # 构建后直接运行
npm test           # 70 个测试（含 Agent 的 12 项验收）
npm run typecheck  # 严格类型检查
npm run pack       # 生成免安装文件夹 release/win-unpacked
npm run dist       # 生成 Windows 安装包（必须在 Windows 上执行）
```

## 怎么玩

| 操作 | 反应 |
| --- | --- |
| 单击头部 | 随机：微笑 / 眨眼 / 歪头 / 开心 |
| 单击身体 | 平时疑惑；开心时微笑；睡着时醒来；生气时不理你 |
| 双击 | 开心跳一下，并打开聊天窗口 |
| 鼠标在头上来回移动 | 摸头：闭眼微笑、冒爱心、好感度上升 |
| 按住拖动 | 被拎起来；拖久了会挣扎；松手会掉下去再站起来 |
| 连续抓她 | 第 1 次惊讶，第 2 次不满，第 3 次生气（过一会儿自己消气） |
| 右键 | 菜单：聊天、切换动作、大小、暂停自动移动、置顶、音效、打开 Claude 桌面版、设置、隐藏、退出 |
| 托盘图标 | 显示 / 隐藏、聊天、设置、退出 |

角色以外的透明区域不拦截鼠标，可以正常点到后面的窗口。

## 让她帮你做事（智能体模式）

在聊天框直接说需求，例如“在桌面建一个叫 AI项目 的文件夹”“打开 VS Code”“把桌面的图片放到图片文件夹”。
她会自己选工具、按步骤执行、检查结果再汇报。查看类操作直接做；新建、移动等会问你；删除、覆盖、运行命令每次都问。
做不到的事会直接说缺少什么能力，可以通过插件或 MCP 扩展。

## AI 聊天（可选）

右键 → 设置 → 勾选"启用 AI"，填 Base URL、模型名、API Key（任何 OpenAI 兼容接口）。
没配置或断网时是离线模式，桌宠其他功能不受影响。

安全设计：

- API Key 只保存在主进程（能用系统加密时会加密保存），页面只知道"有没有填"。
- 请求由主进程发出，页面的 CSP 禁止它自己联网。
- 模型只能通过回复末尾的标签 `[[emotion:happy|action:wave]]` 影响桌宠，
  值必须在白名单里，否则忽略。程序不会执行模型返回的任何代码或命令。

## 目录结构

```text
assets/characters/   角色图片 + manifest.json（素材清单）
electron/            主进程：窗口、托盘、配置存储、AI 请求、IPC
  agent/             智能体：AgentController、ToolRegistry、ToolExecutor、PermissionManager、TaskPlanner、
                     TaskVerifier、AgentMemory、ToolPluginManager、TaskLogger、tools/、platform/
examples/plugins/    插件示例
  main.ts  windowManager.ts  ipcHandlers.ts  preload.ts  configStore.ts  aiClient.ts
shared/              主进程和页面共用的类型、常量、AI 标签协议
src/engine/          桌宠引擎（不依赖 React）
  PetEngine.ts            总调度，每帧更新
  PetStateMachine.ts      状态机：现在在做什么、能不能被打断
  AnimationController.ts  把状态变成画面（换图、缩放、旋转、起伏）
  SpriteManager.ts        加载图片、缺图兜底、透明检测、像素级命中
  DragController.ts       抓起、摆动、挣扎
  MovementController.ts   走路、重力、落地、屏幕边界
  InteractionController.ts 鼠标事件 → 单击/双击/摸头/拖动，以及鼠标穿透
  BlinkController.ts  BehaviorScheduler.ts  EmotionSystem.ts  Effects.ts  SoundPlayer.ts
src/components/      PetView（桌宠窗口）、ChatPanel、SettingsPanel
src/store/           Zustand 状态
tests/               单元测试
docs/                素材文档、状态机说明、验证清单
```

## 文档

- [素材命名与管理](docs/ASSETS.md)
- [动画状态机说明](docs/STATE_MACHINE.md)
- [智能体架构、工具、权限、插件](docs/AGENT.md)
- [已验证 / 未验证功能清单（含 Windows 手动测试步骤）](docs/VERIFICATION.md)

设置和数据保存在 `%APPDATA%\Chibi Desktop Pet\config.json`（开发模式是 `%APPDATA%\chibi-desktop-pet`）。
