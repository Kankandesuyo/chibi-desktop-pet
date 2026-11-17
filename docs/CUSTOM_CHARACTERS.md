# 换成自己的桌宠形象

不需要改代码，也不需要重新打包。每个自定义角色就是一个文件夹，放在：

```
%APPDATA%\chibi-desktop-pet\characters\<角色名>\
```

在 **设置 → 她自己 → 角色** 里可以直接选它。

## 最快的做法（推荐）

1. 打开设置，在「角色」下面的输入框里写一个名字，点 **用当前角色做模板**。
   程序会把当前角色的全部图片和 `manifest.json` 复制到一个新文件夹，切换过去，并打开角色文件夹。
2. 用你自己的图片**替换**文件夹里的 PNG，文件名保持不变。
3. 点 **重新载入形象**，桌宠马上换成新图片。

改了 `manifest.json`（比如名字、配色），点 **刷新列表** 或 **重新载入形象** 就能生效。

## 图片要求

和内置角色一样（详见 [ASSETS.md](ASSETS.md)）：

- 透明背景 PNG；
- 默认画布 **640×580**，脚底中心在 **(320, 552)**，站立时身高约 **440 像素**；
- 所有图片画布一致、脚底对齐，切换姿势时人物才不会跳动。

画布大小或脚底位置不同也可以，在 `manifest.json` 里写 `canvas` 即可：

```json
"canvas": { "width": 800, "height": 800, "anchor": [400, 760], "standHeight": 600 }
```

## manifest.json

最少只需要一张站立图：

```json
{
  "label": "我的角色",
  "appearance": "Q 版女孩，银色短发，穿蓝色卫衣",
  "theme": "blue",
  "poses": { "idle": { "file": "idle.png" } },
  "states": { "idle": ["idle"] }
}
```

| 字段 | 作用 |
| --- | --- |
| `label` | 设置里显示的角色名（不写就用文件夹名） |
| `appearance` | 她的外貌描述，AI 聊天时会用到，让她知道自己长什么样 |
| `theme` | `orange` 或 `blue`：聊天和设置窗口的配色（界面颜色选「跟随角色」时生效） |
| `icon` | 托盘和窗口图标，填同一文件夹里的 PNG 文件名（可选） |
| `note` | 显示在设置里的一行说明（可选） |
| `poses` | 姿势：名字 → `{ "file": "xxx.png" }`，可选 `bounds`、`grab`、`cheeks`、`hem` |
| `states` | 每个状态用哪些姿势，例如 `"happy": ["wave", "jump"]`，写多张就随机选一张 |
| `sequences` | 走路等连续动画的帧序列（参考模板里的写法） |
| `blink` | 眨眼用的睁眼 / 闭眼图；写 `null` 关闭眨眼 |
| `fallback` | 找不到图时用哪个姿势，默认 `idle` |

可用的状态名：`idle`、`blink`、`lookAround`、`walkLeft`、`walkRight`、`run`、`turnLeft`、`turnRight`、
`jump`、`dragStart`、`dragging`、`struggling`、`falling`、`landing`、`petting`、`happy`、`shy`、`angry`、
`sleeping`、`waking`、`talking`。没写的状态会用 `idle` 加程序动作代替。

**随机小场景**：`eating`（吃饭）只在清单的 `sequences` 里有同名帧序列时才会出现，
空闲时和张望、走动一起被随机挑中；每次随机吃 1～3 口，总是播完整一口才停。写法参考内置鲸鱼女仆：

```json
"sequences": {
  "eating": { "frames": ["eat-1", "eat-2", "eat-3", "eat-4", "eat-5", "eat-6", "eat-5", "eat-6", "eat-7", "eat-8"], "frameDurationMs": 280 }
}
```

文件夹里没写进 `poses` 的 PNG 也会以文件名自动注册成一个姿势。

## 出问题时

- 设置里会列出不能用的文件夹和原因，比如缺少 `manifest.json`、JSON 格式有误、没有 PNG。
- 清单里写了但找不到的图片会用 `fallback` 代替，不会崩溃。
- 角色文件夹被删掉或改名后，桌宠会先显示默认形象，设置里标为「找不到」。
- 出于安全考虑，程序只读取角色文件夹里**直接放着的 PNG** 和 `manifest.json`，子文件夹和其他文件一律不读。

## 分享你的角色

把整个角色文件夹打包发给别人，对方解压到自己的 `characters` 文件夹里就能用。
请只分享你有权分发的图片。
