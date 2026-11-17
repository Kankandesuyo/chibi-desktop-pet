# 动画状态机说明

代码：`src/engine/PetStateMachine.ts`（纯逻辑，无渲染，测试在 `tests/stateMachine.test.ts`）。

## 核心规则

同一时刻只有一个状态。每个状态有**优先级**、**持续时间**和**结束后去哪**。

| 优先级 | 组 | 状态 |
| --- | --- | --- |
| 5 | 拖动 | dragStart, dragging, struggling |
| 4 | 下落与着地 | falling, landing |
| 3 | 用户互动 | petting, happy, shy, angry, jump, blink, waking |
| 2 | 对话 | talking |
| 1 | 自动行为 | lookAround, walkLeft, walkRight, run, turnLeft, turnRight, sleeping |
| 0 | 待机 | idle |

- `request(状态)`：鼠标、AI、自动行为调度器用它"申请"。新状态优先级 **不低于** 当前状态才会被接受，否则返回 false、什么都不变。
- `force(状态)`：只有"拥有"当前状态的控制器（拖拽、物理）和计时器使用。

额外的硬规则：

- **被拎着时**：只能在拖动组内部切换。自动行走、点击反馈都进不来。
- **下落中**：只能被再次接住（dragStart），或由物理触发 landing。
- **睡觉时**：只接受 waking 或被抓起，不会突然做别的动作。点她是"慢慢醒来"。
- **生气时**：点击不触发反馈（"哼，不理你"）。

## 计时与流转

| 状态 | 持续 | 结束后 |
| --- | --- | --- |
| dragStart | 0.24 秒 | dragging |
| dragging | 直到松手 | （松手 → falling） |
| struggling | 约 1～2.3 秒（随机，由 DragController 结束；6 秒为保险上限） | dragging（之后隔 2.8～6.5 秒随机再次挣扎，越累间隔越长） |
| falling | 直到触地 | landing |
| landing | 0.45 秒 | idle |
| turnLeft / turnRight | 0.26 秒 | walkLeft / walkRight |
| walkLeft / walkRight | 2.5–6 秒 | idle |
| run | 1.2–2.2 秒 | idle |
| sleeping | 25–70 秒 | waking |
| waking | 0.9 秒 | idle |
| petting | 1.1 秒（继续摸会续时） | idle |
| happy / shy / angry / jump / blink / lookAround | 0.7–3.2 秒 | idle |
| talking | 最长 30 秒（回复结束就退出） | idle |

每个限时状态都会自己结束，所以动画被打断后不会卡住（测试"every timed state eventually
returns…"覆盖了全部 21 个状态）。

## 一次拖拽的完整流程

```text
按住角色 → dragStart(惊讶) → dragging(悬空，身体随速度摆动)
                                  ↓ 拖满 2.6 秒
                              struggling(挣扎、冒汗) → dragging → …
松手 → falling(重力加速) → 触地 → landing(压扁回弹，摔得重会冒星星) → idle
```

拖动时窗口位置由主进程跟随真实鼠标（每 10 毫秒），页面里的角色相对抓握点做弹簧摆动，
所以看起来身体略微滞后于鼠标，速度越快摆得越大。

## 状态 → 画面

状态只决定"做什么"。`AnimationController` 负责"长什么样"：

- 选图：按 `manifest.json` 的 `states` 表（见 [ASSETS.md](ASSETS.md)）。
- 换图：140 毫秒淡入淡出；转身时先横向压窄再换成侧视图，脚底锚点和身高不变。
- 程序动作：呼吸、走路起伏、跳跃抛物线、落地挤压回弹、摸头时向鼠标倾斜、睡觉时点头。
- 眨眼是独立的 `BlinkController`：只在正面站立图上、每隔几秒把 idle 换成 blink 约 0.1 秒，
  偶尔连眨两次，不占用状态机。

## 自动行为

`BehaviorScheduler` 只在 idle 时工作，两次自动行为之间至少隔 3.5 秒，频率由设置里的
"自动移动频率"控制。精力低或 150 秒没人理她时会睡觉。"暂停自动移动"会让它停止申请走动。

## 情绪

`EmotionSystem` 维护 mood / affection / energy / interactionCount，并保存到本地。
它只"建议"反应（比如抓第三次建议生气），是否执行仍由状态机的优先级决定。

## 被拎着时的表现（DragController）

拖动不再是固定循环，全部由 `src/engine/DragController.ts` 决定：

- 物理：身体是挂在手上的欠阻尼钟摆（停手后会来回荡几下）；下半身（腿、裙摆、发梢）是慢半拍的第二段钟摆；沿身体方向有一根弹簧，猛地上提会拉长、下放会缩起并让裙摆飘起。
- 小动作：两次挣扎之间随机切换 `dangle`（垂着）/ `kick`（蹬腿）/ `peek`（左右张望）/ `limp`（没力气）。
- 挣扎：间隔、时长、频率都随机，抖动是一阵一阵的。
- 反应：来回快速摇晃 → 冒星星、发晕；甩得很快 → 惊叫；拎 10 秒以上逐渐变累，挣扎变少变弱。
- 可选图片：角色里若有 `hang-kick`、`hang-look`、`hang-tired`、`dizzy` 这几个姿势（manifest 里要写 `grab`），会在对应时刻自动换上；没有就一直用 `hang`。
