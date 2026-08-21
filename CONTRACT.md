# 桌面AI搭档 — 接口契约（全队必读）

项目根目录: `/Users/mac/WorkBuddy/2026-08-19-19-23-44/desktop-pet/`

## 目录结构

```
desktop-pet/
├── package.json
├── main/                  # Electron主进程
│   ├── main.js           # 入口：透明置顶窗口
│   ├── preload.js        # contextBridge
│   └── tray.js           # 系统托盘
├── src/                   # 渲染进程
│   ├── index.html        # 宠物主窗口
│   ├── settings.html     # 设置窗口
│   ├── core/
│   │   ├── llm.js        # LLM服务 [backend]
│   │   ├── memory.js     # 记忆系统 [backend]
│   │   ├── personality.js# 性格引擎 [backend]
│   │   ├── perception.js # 屏幕感知 [backend]
│   │   ├── pet.js        # 宠物控制器/状态机 [frontend]
│   │   ├── live2d.js     # Live2D渲染 [frontend]
│   │   └── bubble.js     # 气泡/对话UI [frontend]
│   ├── live/
│   │   ├── danmaku.js    # 弹幕服务(插件化) [live]
│   │   ├── sources/mock.js    # 模拟源 [live]
│   │   └── sources/douyin.js  # 抖音源 [live]
│   └── assets/models/     # Live2D模型
└── data/                  # 运行时数据(记忆/配置/性格) gitignore
```

## 全局事件总线

所有模块通过 `window.PetEvents`（EventEmitter实例，preload注入）通信：

| 事件名 | 载荷 | 说明 |
|--------|------|------|
| `danmaku:message` | `{user, text}` | 弹幕消息 |
| `danmaku:gift` | `{user, gift, count}` | 礼物 |
| `danmaku:enter` | `{user}` | 观众进入 |
| `danmaku:follow` | `{user}` | 关注 |
| `scene:change` | `{scene, confidence}` | 场景变化 work/fun/slack/rest/unknown |
| `perception:paused` | `{}` | 感知暂停/恢复 |
| `emotion:change` | `{emotion}` | 情绪变化 |
| `personality:change` | `{traits}` | 性格维度变化 |
| `speak:request` | `{text, duration}` | 请求说话 |

## 模块接口

### llm.js [backend]
```js
class LLMService {
  constructor(config) // config: {baseURL, apiKey, model}
  async chat(messages) // messages: OpenAI格式，返回string
  async vision(imageBase64, prompt) // 图片理解，返回string
  async chatStream(messages, onChunk) // 流式
}
```

### memory.js [backend]
```js
class MemoryService {
  async add(type, content, meta) // type: 'short'|'long'|'emotional'
  async search(query, limit=5) // 相关性检索
  async getContext(maxItems=10) // 组装上下文给LLM
  async summarize() // 压缩长期记忆
}
```

### personality.js [backend]
```js
class PersonalityEngine {
  constructor() // 首次创建随机性格种子
  getTraits() // {lively:0.6, calm:0.3, clingy:0.5, independent:0.4, ...}
  async applyEvent(eventType, weight) // 事件影响维度漂移
  getSystemPrompt() // 生成性格化system prompt
  getOwnerProfile() // 主人画像
  async updateOwnerProfile(interactionData) // 更新画像
}
```

### perception.js [backend]
```js
class PerceptionService {
  constructor(opts) // {interval=30000, enabled, blacklist:[]}
  start() / stop() // 截屏循环
  // 内部: 截屏→llm.vision→场景分类→PetEvents.emit('scene:change')
}
```

### pet.js [frontend]
```js
class PetController {
  setEmotion(emotion) // happy/bored/sad/excited/sleepy
  playMotion(name) // 播放Live2D动作
  speak(text) // 气泡说话
  getState() // 当前完整状态
}
```

### live2d.js [frontend]
```js
class Live2DRenderer {
  async init(container, modelPath)
  playMotion(group, index) / playExpression(name)
  onHit(callback) // 点击命中
  setDraggable(bool)
}
```

### danmaku.js [live]
```js
class DanmakuService extends EventEmitter {
  async connect(sourceConfig) // {type:'mock'|'douyin', roomUrl?}
  disconnect()
  // 内部emit: 'message'|'gift'|'enter'|'follow'
}
```

## Electron窗口规格（T1骨架）

- 透明 `transparent:true`、无边框 `frame:false`、置顶 `alwaysOnTop:true`（screen-saver级）
- 尺寸 400x500，`hasShadow:false`
- `setIgnoreCursorEvents` 支持穿透切换
- macOS需 `vibrancy` 关闭，`backgroundColor:'#00000000'`
- preload暴露: PetEvents, screenAPI(截屏), windowAPI(拖动/穿透)

## 技术约定

- 渲染进程模块用 ES modules，`<script type="module">`
- 数据持久化统一 `data/` 目录：`data/config.json`、`data/memory.json`、`data/personality.json`
- LLM用OpenAI兼容格式（fetch直调，不用SDK），支持vision（image_url传base64）
- Live2D模型用官方免费示例 Hiyori（https://cdn.jsdelivr.net/gh/guansss/pixi-live2d-display/test/assets/hiyori/hiyori_free_t08.model3.json）下载到本地 `src/assets/models/hiyori/`
- Node >= 18，Electron >= 28
