# 素材命名与管理

## 现有素材

所有图片都在 `assets/characters/`，统一为 **640×580 透明 PNG**，脚底锚点在 **(320, 552)**，
站立时角色高约 440 像素。`manifest.json` 是清单。

| 文件 | 姿势 | 来源图 | 用在哪些状态 |
| --- | --- | --- | --- |
| idle.png | 正面站立 | 01 | idle, lookAround, landing, waking, talking |
| blink.png | 闭眼（眨眼专用） | 01 + 14 的眼睛 | 眨眼的闭眼帧 |
| closed-smile.png | 闭眼微笑 | 14 | petting, shy, sleeping |
| wink.png | 单眼眨眼 | 15 | blink |
| wave.png | 挥手 | 16 | happy |
| happy.png | 眨眼比耶 | 06 | happy |
| kick.png | 眨眼踢腿 | 11 | happy |
| jump.png | 开心跳跃 | 17 | jump, falling |
| left.png / right.png | 左 / 右侧视图 | 02 / 12 | walkLeft, turnLeft / walkRight, turnRight |
| back.png | 背面 | 13 | angry（背过身不理你） |
| run-left.png | 向左小跑 | 05 | run（向左时） |
| struggle.png | 惊慌挣扎 | 07 | dragStart, struggling |
| hang.png | 被拎着悬空 | 09 | dragging |

没有用到的原图：03、08（重复的侧视图）、04、10（重复的正面图）。

## 原图是怎么处理的

ChatGPT 生成的 17 张图里，一部分带浅灰底色和脚下阴影，一部分自带特效（星星、汗滴、
鼠标箭头、灰尘）。`tools/` 里的三个 Python 脚本做了这些事：

1. `cut.py`：去掉底色和阴影，只保留角色本体，去掉画进图里的特效。
2. `prep.py`：把两批画风略有差异的图缩放到同一身高，放到统一画布上并对齐脚底，写出 manifest。
3. `blink.py`：把"闭眼微笑"图的眼睛区域对齐后贴到站立图上，得到 `blink.png`。
   这样眨眼时只有眼睛变，身体一个像素都不动。

特效（爱心、问号、汗滴、Zzz、星星）改由程序实时绘制，所以不会被固定在图片里。

## 添加或替换素材

1. 准备透明背景 PNG，画布 640×580，脚底中心放在 (320, 552)，站立身高约 440 像素。
2. 放进 `assets/characters/`。目录里的 PNG 会被自动扫描（构建时），不在清单里的文件
   也会以文件名注册成一个姿势。
3. 在 `manifest.json` 里：
   - `poses` 加一项：`"sit": {"file": "sit.png"}`。可选 `bounds: [x, y, 宽, 高]`（角色范围）、
     `grab: [x, y]`（被拎起时的抓握点）、`cheeks`（腮红位置）。
   - `states` 里把它分配给某个状态：`"sleeping": ["sit"]`。一个状态写多张图会随机选一张。
4. 重新 `npm run dev` 或 `npm run pack`。

## 程序会替你检查的事

- **缺图**：清单里写了但文件不存在 → 用 `fallback`（默认 idle）代替，不会崩溃。
- **背景不透明**：四个角有三个以上不透明 → 控制台警告"背景不是透明的"。
- **尺寸不统一**：不是 640×580 → 警告位置可能有偏差。
- 全部图片都缺失时，会画一个占位小人，程序仍能运行。

警告可以在开发模式的 DevTools 控制台里看到（前缀 `[sprites]`）。

## 重要限制

这些是**一张一个姿势的独立立绘，不是连续动画帧，也没有骨骼**。走路、呼吸、摆动、挤压回弹
都是对整张图做位移、缩放、旋转、倾斜和淡入淡出实现的。想要真正的走路循环，需要再画
逐帧图（例如 walk-left-1/2/3/4.png），然后在 AnimationController 里加帧序列播放。
另外，向右跑没有专门的图：不能把 run-left 镜像，因为发饰在头的一侧，镜像后会跑到另一边，
所以向右跑用的是右侧视图加更快的起伏。

## 逐帧动画（走路序列）

有逐帧图时，引擎优先播放逐帧图，没有才用分层摆腿（`tools/rig.py` 生成的 `*-body.png` / `*-leg.png`）。

1. 让 GPT 生成横向排列的走路精灵图（纯白背景，帧等宽、脚底在同一水平线）。
2. `python3 tools/walkframes.py 精灵图.png walk-right assets/characters` → 生成 `walk-right-1.png …`，自动去白底、统一大小、对齐脚底。
3. 在 `manifest.json` 的 `poses` 里登记这些帧，在 `sequences` 里加 `"walkRight": {"frames": ["walk-right-1", …], "fps": 7}`（跑步用 `"run:right"`）。
4. 运行 `python3 tools/rig.py assets/characters` 更新各姿势的裙摆线，然后重新构建。

目前已有：`walkLeft`、`run:left`（walk-left-1~4，来自 GPT 生成的精灵图）。

## 多角色

- 角色列表：`shared/characters.ts`（id、名称、外观描述、素材说明）；素材登记：`src/config/characters.ts`。
- 每个新增角色一个文件夹 `assets/characters/<id>/`，内含同格式的 `manifest.json` 和 640×580 的透明 PNG。原橙发角色仍在 `assets/characters/` 根目录，互不混放。
- 设置 →「她自己」→ 角色，选择后立即切换并保存。

### manifest 里和动作有关的键

| 键 | 作用 |
|---|---|
| `states` | 状态 → 单张图（缺图自动退回 `fallback`） |
| `sequences` | 状态 → 逐帧图；`fps` 或 `frameDurationMs`；`approximateMirroring: true` 表示镜像占位 |
| `blink` | `{base, closed}`；写 `null` 表示没有闭眼图，眨眼关闭 |
| `procedural` | 说明哪些状态目前是程序模拟（平移 / 倾斜 / 缩放） |
| `missing` | 还没画的素材清单 |

以后补图：把 PNG 放进角色文件夹，在 `poses` 加一条，再把 `states` / `sequences` / `blink` 指过去即可，不用改状态机。

### DeepSeek 鲸鱼女仆（`deepseek`）

导入命令（不改动原始素材）：

    python3 tools/import_character.py <素材包目录> assets/characters/deepseek tools/deepseek-holes.json

- 真图：正 / 左 / 右 / 背立绘，向左走 4 帧（180ms/帧）。
- 镜像占位：向右走 4 帧（发饰、蝴蝶结左右是反的）。
- 程序模拟：跳、开心、摸头、害羞、被拎起、挣扎、下落、落地；跑步用走路帧加速。
- 关闭：眨眼。
- `tools/deepseek-holes.json`：自动抠图漏掉的发丝间白底，逐块人工确认后去除。

### 3×3 动作表情图（2026-11-17 补充）

    python3 tools/import_sheet.py <图.png> <输出目录> 3x3 closed-smile,shy,wave,angry,hang,struggle,jump,fall,sleep angry tools/deepseek-sheet-holes.json

- 对应状态：摸头→closed-smile，害羞→shy，开心→wave / closed-smile，生气→angry，拖动→hang，挣扎→struggle，跳→jump，下落→fall，睡觉→sleep。
- hang / struggle 自带一只手，`grab` 设在手捏住的位置，拖动时手正好在鼠标下。
- 这张图约 4 头身，立绘和行走帧约 2.5 头身，按同一站立高度对齐，切换时身形会变。
- 仍缺：闭眼（需与 idle 完全同姿势）、落地、原生向右走、跑步。
