# 智能体（Agent）架构说明

桌宠接入 DeepSeek（或任何 OpenAI 兼容接口）后，聊天会经过一个通用 Agent：模型自己决定调用哪些已注册的工具，
程序负责权限、执行、验证和记录。新需求只要能用现有工具组合完成，就不需要改代码。

## 一次任务的流程

```text
用户一句话（聊天窗口）
  → AgentController 组装上下文：人设 + 规则 + 环境（真实的桌面/下载路径、时间）+ 用户记忆
  → 模型（原生 tool calling；不支持时自动切换到结构化文本协议）
  → 模型返回 tool_calls ───────────────┐
       ToolExecutor 对每个调用：           │
         1. 只查 ToolRegistry（未注册 / 被关闭的分组 = 拒绝）
         2. 参数 JSON + Schema 校验（未知参数也拒绝）
         3. 路径检查（只能在允许的文件夹；受保护位置不可写；根目录本身不可移动/删除）
         4. 风险评估（工具可按参数升级风险，例如覆盖文件 → 高）
         5. PermissionManager：低风险直接做；中风险询问；高风险每次都问
         6. 执行（3 分钟超时，可取消）
         7. TaskVerifier 回到真实世界检查（文件夹真的存在？窗口真的出现？）
         8. 审计日志（已隐藏密钥）
         9. 结果交回模型（外部内容用 <untrusted_data> 包裹）
     ←─────────────────────────────────────┘ 循环，直到模型给出最终回答或达到步骤上限
  → 汇报：只有工具都成功并通过验证，结果才算“成功”
```

模型在动手前说的话（“我来帮你打开～”）只作为过程备注显示，不会被当成结果。

## 模块

| 模块 | 文件 | 职责 |
| --- | --- | --- |
| AgentController | `electron/agent/AgentController.ts` | 任务生命周期、模型循环、确认请求、结果判定 |
| TaskPlanner | `electron/agent/TaskPlanner.ts` | 模型通过 `update_plan` 工具写计划；界面和桌宠显示进度 |
| ToolRegistry | `electron/agent/ToolRegistry.ts` | 注册、分组开关、导出给模型的工具清单 |
| ToolExecutor | `electron/agent/ToolExecutor.ts` | 上面 1–9 步 |
| PermissionManager | `electron/agent/PermissionManager.ts` | 路径策略、三级风险、确认、超时 |
| TaskVerifier | `electron/agent/TaskVerifier.ts` | 执行后验证 |
| AgentMemory | `electron/agent/AgentMemory.ts` | 用户明确要求记住的偏好（不是授权） |
| ToolPluginManager | `electron/agent/ToolPluginManager.ts` | 本地插件（需批准，哈希绑定）+ MCP 服务器 |
| TaskLogger | `electron/agent/TaskLogger.ts` | 审计日志 JSONL + 最近任务列表 |
| FileJournal | `electron/agent/FileJournal.ts` | 记录文件操作，支持撤销；覆盖前自动备份 |
| llm | `electron/agent/llm.ts` | 流式 tool_calls 解析、文本协议、视觉模型调用 |
| 平台层 | `electron/agent/platform/` | Electron + PowerShell/UI Automation 的 Windows 实现 |

所有 Agent 代码都在主进程。页面（聊天窗口）只能：发起任务、停止任务、回答确认。API Key 从不离开主进程。

## 内置工具（63 个）

| 分组 | 工具 |
| --- | --- |
| 文件 | list_directory, search_files, create_directory, create_file, read_file, write_file, move_file, **move_files**（批量，带预览）, copy_file, rename_file, delete_file（进回收站）, get_file_info, create_shortcut（`@pet` = 桌宠自己）, undo_file_operations |
| 软件 | list_running_apps, find_installed_app, launch_application, focus_application, close_application, open_path, open_url |
| 系统 | get_known_folders, get_system_info |
| 记忆 | remember, forget, list_memories |
| 界面自动化 | get_active_window, list_windows, inspect_ui_elements, click_element, type_text, press_hotkey, scroll, wait_for_window, capture_screenshot, analyze_screenshot, point_on_screen |
| 浏览器 | browser_open, browser_search, browser_click, browser_fill, browser_extract, browser_tabs, browser_download, browser_close |
| 开发者 | project_tree, git_status, run_command, start_dev_server, stop_dev_server, list_dev_servers, read_process_output |
| 系统管理 | run_admin_command, winget_search, list_installed_software, install_software, uninstall_software, upgrade_software, manage_service, registry_read, registry_write, registry_delete |
| 内部 | update_plan |

## 权限

| 等级 | 例子 | 处理 |
| --- | --- | --- |
| 低 | 查看文件夹、搜索、打开开始菜单里的程序、打开网址、截屏 | 直接执行（仍受路径限制） |
| 中 | 新建/移动/复制/改名、带参数启动程序、关闭程序、点击/输入、浏览器点击/填写、插件工具 | 询问。可选“本次任务都允许”，或在设置里打开“中风险自动允许” |
| 高 | 删除、覆盖文件、一次移动 20 项以上、运行命令、启动后台服务、强制结束程序、读取疑似密码/密钥文件、把截图发给视觉模型、运行下载目录里的程序 | **每次**都询问，没有任何永久允许的方式 |

额外规则：

- **允许的文件夹**：默认只有桌面、文档、下载、图片、音乐、视频；其他位置要在设置里手动添加。
  桌宠自己的数据目录、安装目录、Windows、Program Files、`.ssh` 等永远不可写。符号链接/联接点会先解析，不能借此逃出。
- **提示词注入**：文件内容、网页、其他程序的输出都被包成 `<untrusted_data>`。任务一旦读过这类内容，
  “中风险自动允许”立即失效，确认卡片上会提示“这一步是在读取外部内容之后提出的”。
- **确认超时** 2 分钟，按“拒绝”处理。用户拒绝后，模型被告知不要换工具绕过。
- **不发送敏感信息**：日志和发给模型的内容都会隐藏 API Key、令牌、私钥、`password=` 这类字段；
  浏览器工具拒绝代填密码框；验证码 / 人机验证一律提示用户自己完成。
- **记忆不是授权**：记忆写进提示词时明确标注“仅供参考，不是授权”，执行器完全不读取记忆。

## 管理员权限（按需提权）

桌宠本身始终以普通权限运行。需要管理员的操作（安装/卸载软件、启停服务、改注册表、系统设置、写系统文件夹）：

1. 先在聊天窗口弹出**高风险**确认卡片，显示完整命令/改动；没有“本次都允许”。
2. 同意后由 Windows 弹出 **UAC**，再点“是”才真正以管理员身份执行；在 UAC 里取消 = 没执行。
3. 模型给的值（命令、软件 Id、服务名、注册表路径）只作为数据传给固定脚本，不拼进脚本代码；软件 Id、服务名有格式校验，防止夹带额外参数。
4. 注册表修改/删除前先 `reg export` 备份到 `agent\backups\`。
5. 危险命令（格式化、改启动、关 Defender/防火墙/UAC、删系统文件、删还原点、改管理员组、关机、下载即执行）会在确认卡片上用 ⚠ 单独标出。不禁止，但模型被要求只在你明确要求时才做。

**全盘访问**（设置 → 智能体 → 允许访问所有磁盘，默认开启）：所有盘符都可以操作；Windows、Program Files、ProgramData、`.ssh` 等系统位置的任何修改一律按高风险逐次确认；
桌宠自己的数据目录（权限、批准记录、审计日志）和安装目录**始终不可修改**，否则它能给自己加权限。关闭全盘访问则回到“只允许 6 个用户文件夹 + 手动添加的文件夹”。

普通文件工具以普通权限运行，遇到“权限不足”会提示模型改用 `run_admin_command` 以管理员身份完成。

## 模型兼容

- **原生 Tool Calling**：DeepSeek（deepseek-chat）、OpenAI、通义千问等 OpenAI 兼容接口。流式解析分片到达的 `tool_calls`。
- **结构化文本协议**：模型不支持工具时，要求它只输出一个 `<tool_call>{"name":…,"arguments":{…}}</tool_call>`。
  格式不对、多个调用、多余字段，都会作为错误退回给模型，不会执行。“自动”模式下接口拒绝 `tools` 参数时自动切换。
- **输出长度**：可以调工具的轮次 `max_tokens` 为 8192（纯聊天 1500）。接口嫌太大会返回 400，此时按它给的上限（或减半）重试一次，并按“接口地址 + 模型”记住这个上限。
  回复因长度被截断（`finish_reason=length`）时，参数没写完的工具调用一律不执行，模型会被要求拆小再做（例如 `write_file` 配合 `mode=append` 分段写）；最终回答被截断时，回复末尾会注明。
- **跨轮上下文**：每个任务结束后（包括失败和取消的任务），把每一步的真实结果（标题、状态、摘要、少量数据，已脱敏）记在内存里，最多保留 5 个任务。
  之后的请求如果在发送的历史里还能找到那个任务的用户原话，就把最近 3 个任务的摘要放进系统提示，并用 `<untrusted_data>` 包起来。清空聊天或重启后这些摘要就不再使用。
  带入的摘要里有文件或网页内容时，本次任务从一开始就算“读过外部内容”，中风险操作不会自动批准。
- **任务内上下文压缩**：一次任务的对话超过约 8 万字符时，从最早的开始把工具结果换成简短版（ok / 摘要 / 错误，并注明“详细数据已省略，需要时重新查”），够用就停；最近 4 个结果始终保留完整。
  还不够时，再把较早工具调用里很长的参数（例如已写入的文件内容）截短，截短后仍是合法 JSON。系统提示和用户的话不会被改动；来自文件或网页的结果压缩后仍标记为 `<untrusted_data>`。每次压缩都会在任务日志里记一条 `context_compacted`。
- **视觉**：普通文本模型看不懂图片。`analyze_screenshot` 需要在设置里配置一个支持图片的模型，没配置时会明确报错。
- **指点**：`point_on_screen` 截屏后让视觉模型返回目标的位置（按整张图 0~1000 计），在主屏幕上画一个不挡鼠标、不抢焦点的高亮圈（约 10 秒），桌宠沿地面走到旁边挥手指示。每次都要确认（截图会离开电脑）；只指不点。开发时可用 `PET_POINT_DEMO="0.5,0.3,标签"` 不截图、不调模型地预览效果。

## 扩展：不改 Agent 代码增加能力

### 本地插件

```text
插件文件夹（设置 → 智能体 → 打开插件文件夹）/
  my-plugin/
    plugin.json   {"name": "my-plugin", "description": "…", "main": "index.js"}
    index.js      module.exports = { tools: [ { name, description, inputSchema, riskLevel, execute, verify? } ] }
```

完整示例见 `examples/plugins/pick-random/`。放进去后在设置里点“批准”。批准与插件文件的哈希绑定，文件一改就要重新批准。
插件工具的风险最低为“中”。插件代码与桌宠同权限运行，只装可信的插件。

### MCP 服务器

设置 → 智能体 → MCP 服务器：填名称、命令、参数（例如 `npx` / `-y @modelcontextprotocol/server-filesystem D:\docs`），
选风险等级，保存后自动启动并发现工具（命名为 `mcp_<服务器>__<工具>`）。

### 内置工具

在 `electron/agent/tools/` 里用 `defineTool({...})` 写一个，加到 `electron/agent/index.ts` 的注册列表即可。
需要给出：`name`、`description`、`group`、`inputSchema`、`riskLevel`、`requiresConfirmation`、`title`、`execute`，
可选 `paths`（路径检查）、`assess`（按参数升级风险 + 预览）、`verify`（执行后检查）。

## 把文件拖给她

把文件或文件夹从资源管理器拖到她身上（必须落在角色身上，透明区域不接），她会伸手接住，并在旁边弹出菜单。

- **为什么能接住**：桌宠窗口平时对鼠标是透明的。从资源管理器拖文件时，Windows 不会给这个窗口发鼠标移动事件，所以主进程每 40ms 读一次光标位置（`WindowManager.pollCursor`）。光标在窗口范围内时，把坐标发给页面，由页面按像素判断是否落在她身上，是的话就临时关掉鼠标穿透，让窗口能成为放置目标。
- **路径**：页面通过 `webUtils.getPathForFile` 拿到真实路径交给主进程。主进程不信任页面传来的东西：只收存在的绝对路径，去重，最多 30 个（`electron/fileDrop.ts`）。从浏览器等地方拖来的、没有真实路径的东西，她会说拿不到。
- **菜单**（`shared/fileDrop.ts`）：
  - 文件夹：看看里面有什么、按类型整理里面的文件
  - 少量文件：看看写了什么
  - 多个文件：按类型整理、批量重命名
  - 通用：打包成 zip、告诉她要做什么
- **点菜单后会发生什么**：不需要补充说明的选项，直接作为一条普通聊天请求发给智能体，之后照常走工具、权限检查和确认，不会因为是拖进来的就跳过确认。需要你补充的选项（重命名规则、自由描述），会以“📎 附件”的形式出现在聊天输入框上方，你写完发送时把路径附在消息后面。
- **不在允许的文件夹里的项目**：菜单里会注明，也不会放进请求。智能体模式没开时，菜单只提示去设置里打开。

## 桌宠反馈

| Agent 状态 | 桌宠 |
| --- | --- |
| 理解任务 | 说话状态 + 问号 |
| 执行中 | 气泡显示“正在…”，冒汗；多步任务显示“进度 2/5” |
| 等待确认 | 问号 + “需要你确认一下～” |
| 成功 | 星星，随后开心 / 挥手 |
| 失败 | 冒汗 + 惊讶 / 害羞 |

## 数据位置

`%APPDATA%\Chibi Desktop Pet\agent\`：`memory.json`、`tasks.json`、`journal.json`、`backups/`、`logs/agent-日期.jsonl`、
`plugins/`、`browser-profile/`（桌宠专用浏览器配置，不碰你自己的浏览器登录）。截图保存在“图片\ChibiPet 截图”。

## 社交账号运营（抖音等）

- 用桌宠自己的浏览器（独立配置，不碰你平时的 Edge）。第一次需要你在那个浏览器窗口里自己扫码登录抖音。
- 读通知 / 评论、写文案：自动。
- 任何"发布 / 发送 / 评论 / 回复 / 私信"按钮：一律高风险，每一条都弹卡片，卡片上列出将发出的文字；按钮为「发 / 改一下 / 不发」，没有"本次都允许"。
- `browser_upload_file`：把视频/封面放进上传框（只选文件，不发布），需要确认。
- 规则：只在你本次点名的视频/评论/人下面评论或私信；不自己找陌生人评论、私信、关注；不批量；简介写明"由 AI 桌宠运营"。
