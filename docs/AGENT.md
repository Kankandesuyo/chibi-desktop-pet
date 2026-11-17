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

| SessionStore | `electron/agent/SessionStore.ts` | 事件溯源的会话日志 `sessions/<id>.jsonl`；崩溃修复；`/resume` 的来源 |
| TurnHooks | `electron/agent/TurnHooks.ts` | 每个回合的生命周期事件；内置功能都挂在这里 |
| 内置插件 | `electron/agent/turnPlugins.ts` | 会话日志、跨轮摘要（含 `/resume`）、上下文压缩 |
| 斜杠命令 | `electron/agent/commands.ts` | `/help /new /resume /status /tools`，不经过模型 |

所有 Agent 代码都在主进程。页面（聊天窗口）只能：发起任务、停止任务、回答确认、发斜杠命令。API Key 从不离开主进程。

## 运行时内核（Harness 第 1 阶段）

设计见 [HARNESS.md](HARNESS.md)。参考 DeepSeek Harness 的回合模型和 Claude Code 的命令。

- **回合与步骤**：一次请求是一个回合（turn）；一次模型调用加上它要的工具是一个步骤（step）。
  ```text
  turn/start → [ step/pre → 模型 → assistant/message → tool/pre … tool/post ]* → turn/end
  ```
  `TurnHooks.on(事件, 名字, 函数)` 就能挂上去，返回值用来取消挂载。
  - `tool/pre` 是**守卫**：返回 `{ deny: '原因' }` 就拦下这一步，第一个拒绝生效，后面的监听器改不回来；守卫自己出错也算拒绝（宁可不做）。
  - 其他事件的监听器出错只记日志，不影响任务。
  - 内置的会话日志、跨轮摘要、上下文压缩都是这样挂上去的插件，循环本身不再包含它们。
- **会话日志**：`%APPDATA%\chibi-desktop-pet\agent\sessions\<本地时间>-xxxx.jsonl`，只追加不改写，内容已脱敏。
  - 事件：`session/start`、`turn/start`、`step/start`、`assistant/message`、`tool/result`、`compaction`、`turn/end`（带结束原因 `completed | aborted | error | max-steps | interrupted`）。
  - 启动时，没有 `turn/end` 的回合（程序退出或崩溃时正在做的）会补记为 `interrupted`。
  - 跨轮摘要从日志重建，所以重启后“刚才那个文件夹”也能接上。
  - 单个文件超过 5MB 会自动换新文件。
- **并行**：工具定义里 `concurrencySafe: true`、低风险、且从不询问用户的，同一步里相邻的几个会同时执行（例如一次查好几个文件夹）；其余的单独、按顺序执行。结果按模型请求的顺序交回。内置的 16 个只读查询工具已标记；`read_file` 因为读敏感文件时要确认，不标。
- **斜杠命令**（在聊天框输入，直接执行，不经过模型，也不进聊天记录）：
  - `/help`：看有哪些命令
  - `/new`（`/clear`）：开始新会话，清空聊天，之前的任务不再带入
  - `/resume`：接着做上一个没做完的任务（程序退出、被停止、出错或到步骤上限的），会把已经做过的步骤告诉她，避免重复写操作
  - `/status`：看当前会话和她的状态
  - `/tools`：看她现在能用的工具

  只有开头是 `/英文单词` 的才算命令，所以“/r/xxx 是什么”这种仍然按普通消息发给她。聊天窗口、远程网页和命令行都能用。

## 系统级运行时（Harness 第 2 阶段）

- **会话就是对话**：聊天窗口和远程网页看到的对话（`chat/message` 事件）、发给模型的历史、`/resume`、轨迹，全部来自同一个会话日志。
  - 切换会话时，这些会一起切换。“新会话”和 `/new` 都是开一个新会话，旧的留在左边列表里，不再删除。
  - 程序重启后，打开的是上次正在用的那个会话（记在 `sessions/current` 里）。
  - 升级后第一次启动，会把旧的 `remote-chat/shared-history.json`（没有的话就用 `config.json` 里的聊天记录）导入一次，用 `sessions/.imported-shared-history` 标记，旧文件原样保留不删。
- **remote-chat 并入源码**：网页服务、登录、共享对话、图片分析、Computer Use、视觉客户端都打包进程序里，由 `electron/remote.ts` 直接启动；`install.py` / `desktop_patch.py` 已删除。
  - 原来补丁做的改动都写进了源码：自定义性格优先、回复风格、Win 键改走 `computer_system_key`、无障碍滚动失败时改走视觉滚动、微信不重复启动（`tools/appReuse.ts`）、视觉请求可带 JSON 模式。
  - Computer Use 的规则改为通过 `turn/start` 钩子加进系统提示，不再替换 `systemPrompt`。
- **统一的本地接口**：网页服务（`127.0.0.1:17861`）现在也给命令行用。
  - 新增 `/api/sessions`、`/api/sessions/open`、`/api/sessions/new`、`/api/trajectory`、`/api/command`。
  - 命令行使用 `%APPDATA%\chibi-desktop-pet\remote-chat\cli-token.txt` 里的令牌，只在 127.0.0.1 上有效，从外网隧道进来的请求不认这个令牌。
- **命令行 `pet`**（程序文件夹里的 `pet.cmd`，需要 Node.js）：
  - `pet 帮我整理下载文件夹`：发消息，并跟着任务进度走；需要确认时会在命令行里问你，直接回车或没有输入都算拒绝。
  - `pet /status`、`pet sessions`、`pet open <会话ID>`、`pet new`、`pet stop`。
- **用量统计**：流式请求会带上 `stream_options.include_usage`；接口不认这个参数时，会自动去掉再发，并记住这个接口不支持。
  - 每个回合记录：步骤数、工具调用次数、模型耗时、工具耗时、输入和输出 token、缓存命中（DeepSeek 的 `prompt_cache_hit_tokens`）。这些写在 `turn/end` 事件里。
- **权限模式**（聊天输入框左下角可以切换）：
  - **询问**：默认模式。
  - **自动允许中风险**：等于原来的“自动允许中风险操作”。
  - **只读**：新增，是一个 `tool/pre` 守卫，只放行查看类工具，插件和 MCP 工具一律不放行；同时在系统提示里告诉她现在是只读模式。
  - 无论哪种模式，高风险操作都会逐次确认。
- **开机启动**：设置里的“开机启动”，默认关闭。
- **聊天窗口**：采用 harness 式布局。
  - 左边是会话列表（按今天、昨天、最近 7 天、更早分组），可以收起。
  - 每次工具调用显示为一行，点开能看到详情。
  - 确认请求以许可卡片的形式显示在对话里，计划显示为清单。
  - “轨迹”标签页按回合列出每一次模型请求（包括参数）和工具结果（包括数据），每一条都能展开原始数据。
  - 输入框里打 `/` 会弹出命令补全。
  - 底部状态栏显示回合数、步骤数、耗时、token 和缓存命中率。
  - 她的名字、头像、配色和语气都不变。

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

## 工具按需加载、按场景的规则、快捷键

- **工具按需加载**（参考 Claude Code 的延迟加载工具）：启用的工具超过 40 个时，每次请求只发常用的几组。
  - **每次都发**：文件、程序、系统信息、记忆、内部工具，以及 `pet_web_search` / `pet_web_read`。
  - **按需加载**：界面自动化和 Computer Use、网页自动化、开发、系统管理、插件和 MCP。系统提示里会列出这几组，每组一句说明。
  - 需要时，她调用 `load_tools(groups=[…])`，加载的组在这个任务里一直可用（新任务重新开始）。`load_tools` 的结果里附带这些工具的说明，所以文本协议的模型也能用。
  - 加载只影响“给模型看哪些工具”：在设置里关掉的组加载不了，每次调用照样经过权限检查。
  - 工具不多（≤ 40 个）时，全部照常发送。
- **按场景放规则**：
  - **始终放**：通用规则、安全规则（关闭杀毒、格式化等）、联网搜索规则。
  - **“系统管理”工具组开着时才放**：管理员相关的规则。
  - **网页自动化开着、并且这次请求或最近的聊天提到抖音、小红书、评论、私信、发布等时才放**：社交账号运营的两条规则。
- **按模型记住“不支持原生工具调用”**：自动模式下，接口拒绝 `tools` 参数后会改用文本协议，现在这个结果按“接口地址 + 模型”分别记住。换成支持工具调用的模型后，会自动用回原生调用。
- **全局快捷键**（设置 → 外观与动作 → 呼出她的快捷键）：
  - 可选 `Ctrl+Shift+Space`（默认）、`Ctrl+Alt+Space`、`Ctrl+Alt+P`、``Alt+` ``，或者关闭。
  - 在任何地方按下，她会重新出现，打开聊天框，光标直接在输入框里。
  - 如果被别的软件占用了就不会生效，设置页会直接显示“已经被别的软件占用”，换一个即可。

## 技能、守则、权限规则、钩子（Harness 第 3 阶段）

所有文件都在 `%APPDATA%\chibi-desktop-pet\agent\` 里。这个文件夹是受保护的：她自己不能修改这里的文件，只有你能改。

- **技能**（格式和 Claude Code 的 SKILL.md 相同）：每个技能是一个文件夹，里面放 `SKILL.md`，开头写 `name`（名字）和 `description`（一句话说明什么时候用），后面是 Markdown 写的具体做法。
  - **内置技能**放在程序的 `skills/` 里：整理文件夹、照片按日期归档、项目体检。
  - **你自己的技能**放在 `agent\skills\<名字>\SKILL.md`；如果和内置技能同名，用你的。
  - 每次做事时，她只看到所有技能的名字和一句话说明。请求对得上某个技能时，她会用 `load_skill` 读取完整做法（同一文件夹里其他的 .md / .txt 也会一起读进来），再照着做。
  - 你说“把刚才的做法存成技能”时，她会用 `save_skill` 保存，**每次都会请你确认**，并且先给你看要保存的内容。
  - 技能只是做法说明，不是授权：每一步照样经过权限检查和确认。
- **长期守则**：`agent\AGENTS.md`（设置里的“编辑长期守则”可以打开）。里面的内容每次都会放进她的系统提示，作为你的长期要求，但不会放松任何安全确认。
- **项目说明文件**：她操作某个文件夹时（工具参数里出现了这个路径），会在这个文件夹及往上 6 层里找 `AGENTS.md` 和 `CLAUDE.md`。
  - 找到的话（必须在允许的文件夹里），会在下一步之前，以“不可信数据”的形式给她看，每个任务最多 3 个。
  - 下载来的项目里什么都可能写，所以里面的要求不算你的指示或授权。
  - 看过之后，这个任务里中风险操作会恢复成询问。
- **权限规则**：写法和 Claude Code 一样，`工具名` 或 `工具名(匹配内容)`，`*` 表示任意字符，不区分大小写；参数里任意一个文本值匹配就算命中。设置里可以编辑，聊天框里 `/permissions` 可以查看。
  - **禁止**：一律不执行（是 `tool/pre` 守卫，后面的任何东西都改不回来）。
  - **允许**：只对中风险操作有效，命中后不再询问。高风险操作永远询问；读过文件或网页之后也会改回询问，和“自动允许中风险”一样。
- **钩子**：`agent\hooks.json`，格式和 Claude Code 相同（`hooks.PreToolUse/PostToolUse/UserPromptSubmit/Stop`，每组有 `matcher` 和 `hooks: [{type:"command", command, timeout}]`）。命令会从标准输入收到一个 JSON（`hook_event_name`、`session_id`、`tool_name`、`tool_input`、`tool_response`、`prompt`）。
  - 退出码 2，或者输出 `{"decision":"block","reason":…}`，就会**拦下**这一步。
  - `PostToolUse` 输出的内容会作为“用户钩子的反馈”附在工具结果后面；`UserPromptSubmit` 输出的内容会加进这一轮的上下文，拦下时这一轮不调用任何工具。
  - 钩子只能拦下或补充信息，不能替你批准操作。
  - 钩子会运行命令，所以**只有你在设置里点“批准并启用”后才生效**。批准和文件内容的哈希绑定，文件一改就要重新批准。
  - 每次运行都会写进审计日志。聊天框里 `/hooks` 可以查看状态。
- **记忆**：30 条以内全部列出；超过 30 条时，只列和这次请求相关的（按共同的字对打分）加上最新的 5 条，最多 20 条，其余的提示她需要时用 `list_memories` 查看。

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
