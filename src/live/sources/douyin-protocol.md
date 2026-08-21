# 抖音直播弹幕协议调研笔记（douyin-protocol.md）

> 用途：为 Electron **主进程 bridge** 的集成实现提供协议要点。渲染进程侧接口已实现在
> `sources/douyin.js`（bridge 模式），本文档描述主进程需要完成的全部协议工作。
>
> 结论先行：**纯浏览器（渲染进程）不可行**，原因见 §5。主进程方案可行，且有多个成熟开源参考。

参考资料：
- saermart/DouyinLiveWebFetcher（Python，协议最完整）https://github.com/saermart/DouyinLiveWebFetcher
- chenggx/douyin-parse-danmu（含 Node websdk，最接近我们的架构）https://github.com/chenggx/douyin-parse-danmu
- wxr0924/BarrageFly（Tauri/Node 蹲蹲）https://github.com/wxr0924/BarrageFly
- AlwaysPP/DySpider（Python，含完整 wss URL 示例）https://github.com/AlwaysPP/DySpider

---

## 1. 连接总流程

```
① GET https://live.douyin.com/            → 响应 Set-Cookie 里取 ttwid
② GET https://live.douyin.com/<房间号>?msToken=<随机107位>&...（带 ttwid cookie + 浏览器 UA）
                                          → 从 HTML 里正则提取真实 roomId
③ 生成 msToken（随机 107 位字符，字符集 [A-Za-z0-9=_]）
④ 拼接 wss URL（见 §2 参数表）
⑤ 计算签名：参与签名的参数按序拼接 → MD5 → 用 sign.js(Acracker/get_sign) 计算 signature
⑥ 建立 WebSocket（子协议 header 需带 Cookie: ttwid=xxx）
⑦ 每 5~10 秒发送心跳；收到 needAck 的消息要回 ACK
⑧ 收到二进制帧 → PushFrame 解析 → gzip 解压 payload → Response 解析 → 按 method 分发
```

要点：
- URL 里的房间号（如 `live.douyin.com/619592756125`）**不是**真正的 `room_id`，必须从房间页 HTML 里提取：正则 `roomId\":\"(\d+)\"`（渲染前的 `render_data` 或 `self.__pace_f` 数据里）。
- `ttwid`：直接 GET `https://live.douyin.com/` 即可获得（有时需要带合法 UA，无需其他登录态）。
- `msToken`：实测可为随机 107 位字符串，无需真实算法。

## 2. WebSocket URL

host 有多个可用（任选/轮询）：
- `wss://webcast3-ws-web-lq.douyin.com/webcast/im/push/v2/`（低延迟线，最常用）
- `wss://webcast5-ws-web-hl.douyin.com/webcast/im/push/v2/`（DouyinLiveWebFetcher 使用）

完整参数示例（来自 DySpider / DouyinLiveWebFetcher，可工作的模板）：

```
wss://webcast3-ws-web-lq.douyin.com/webcast/im/push/v2/
  ?app_name=douyin_web
  &version_code=180800
  &webcast_sdk_version=1.3.0            (或 1.0.14-beta.0，跟随网页版本)
  &update_version_code=1.3.0
  &compress=gzip
  &internal_ext=internal_src:dim|wss_push_room_id:{room_id}|wss_push_did:{did}|dim_log_id:{...}|fetch_time:{ms}|seq:1|wss_info:0-{ms}-0-0|wrds_kvs:WebcastRoomStatsMessage-{ts}-...
  &cursor=t-{ms}_r-1_d-1_u-1_h-1
  &host=https://live.douyin.com
  &aid=6383
  &live_id=1
  &did_rule=3
  &debug=false
  &endpoint=live_pc
  &support_wrds=1
  &im_path=/webcast/im/fetch/
  &user_unique_id={did}                 (与 internal_ext 里 wss_push_did 一致的设备号)
  &identity=audience
  &need_persist_msg_count=15
  &insert_order_id=3
  &live_reason=''
  &device_platform=web
  &cookie_enabled=true
  &screen_width=1920&screen_height=1080
  &browser_language=zh-CN
  &browser_platform=MacIntel
  &browser_name=Mozilla
  &browser_version=5.0%20(Macintosh...)
  &browser_online=true
  &tz_name=Asia/Shanghai
  &room_id={room_id}
  &heartbeatDuration=0
  &signature={signature}                ← 最后追加
```

注意：`internal_ext` / `cursor` 里的时间戳、did 用伪造值实测也能连通；**signature 与 ttwid 是硬性的**。

## 3. 签名机制（signature）

来自 DouyinLiveWebFetcher `liveMan.py` 的 `generateSignature`：

1. 从 wss URL 中取参数按固定顺序拼成字符串，参数列表（以实际仓库代码为准，集成时核对）：

   `live_id, aid, version_code, webcast_sdk_version, room_id, sub_room_id, sub_channel_id, did_rule, user_unique_id, device_platform, device_type, ac_version / acoustic_version, identity, heartbeatDuration`

   拼接格式形如 `live_id=1,aid=6383,version_code=180800,...`（具体分隔符以仓库源码为准）。
2. 对该字符串求 **MD5**（hex 小写）。
3. 加载 `sign.js`（抖音 Acrawler 混淆代码，仓库自带），调用 `get_sign(md5字符串)` 得到 `signature`，追加到 URL。

Node 实现提示：`sign.js` 是纯 JS、无 DOM 依赖，可直接 `vm.Script` / `node:vm` 沙箱执行；MD5 用 Node 内置 `crypto.createHash('md5')`。

## 4. 消息协议（Protobuf）

外层结构（`douyin.proto` 关键部分，字段号重要）：

```protobuf
message PushFrame {
  uint64 seqId = 1;
  uint64 logId = 2;
  uint64 service = 3;
  uint64 method = 4;
  repeated Header headersList = 5;
  string payloadType = 6;   // 'hb' 心跳 / 'ack' / 正常消息
  bytes  payload = 7;       // gzip 压缩的 Response
}

message Response {
  repeated Message messagesList = 1;
  string cursor = 2;
  uint64 fetchInterval = 5;
  string internalExt = 7;
  uint32 fetchType = 8;
  map<string, string> routeParams = 9;
  uint64 heartbeatDuration = 10;
  bool needAck = 11;
  string pushServer = 12;
  string liveCursor = 13;
  bool historyNoMore = 14;
}

message Message {
  string method = 1;    // 消息类型名，见下表
  bytes  payload = 2;   // 各类型自己的 protobuf 结构
  int64  msgId = 4;
}

message User {
  uint64 id = 1;
  uint64 shortId = 2;
  string nickName = 3;          // 昵称
  uint32 gender = 4;
  string signature = 5;         // 个性签名
  uint32 level = 6;
  uint64 birthday = 7;
  string telephone = 8;
  Image avatarThumb = 9;
  ...
}
```

**消息类型（method）→ 我们事件的映射：**

| method | protobuf 结构 | 关键字段 | 映射事件 |
|--------|--------------|----------|----------|
| `WebcastChatMessage` | ChatMessage | user(User), content(string) | `message {user, text}` |
| `WebcastGiftMessage` | GiftMessage | user, giftId, comboCount/groupCount, gift(嵌套 Gift{name}) | `gift {user, gift, count}` |
| `WebcastMemberMessage` | MemberMessage | user, enterType(1=进房) | `enter {user}` |
| `WebcastSocialMessage` | SocialMessage | user(送礼/关注者), shareType 社交消息（关注/分享） | `follow {user}` |
| `WebcastLikeMessage` | LikeMessage | user, count | 可映射 `message`（点赞），或忽略 |
| `WebcastControlMessage` | ControlMessage | status(3=下播) | status 通知（断开） |
| `WebcastRoomStatsMessage` | RoomStatsMessage | displayLong, total | 统计，可忽略 |

### 接收处理流程

```
ws 二进制帧
 → PushFrame.decode(frame)
 → payloadType === 'hb' ？（心跳，忽略）
 → gzip.inflate(frame.payload)
 → Response.decode(解压结果)
 → 若 response.needAck：
     回发 PushFrame{ payloadType:'ack', payload:internalExt(utf8), logId:frame.logId }
 → 遍历 response.messagesList：
     按 message.method 查表 → 对应结构 decode(message.payload) → 提取字段 → 回调
```

### 心跳

- 每 5~10 秒发送 `PushFrame{ payloadType:'hb', payload:空 }`（DouyinLiveWebFetcher 5s，douyin-live-go 10s，实测 10s 内稳定）。
- 不发心跳约 30~60s 后会被服务端断开。

### Node 依赖建议

- `ws`（WebSocket 客户端，可自定义 header 传 Cookie）
- `protobufjs`（用 `douyin.proto` 生成/动态加载；proto 文件从 DouyinLiveWebFetcher 仓库 `protobuf/douyin.proto` 取）
- `node:zlib`（gzip 解压）
- `node:crypto`（MD5）
- sign.js（从上述仓库下载，随应用打包）

## 5. 为什么纯浏览器/渲染进程不可行

1. **CORS**：获取 `ttwid` 和 `room_id` 必须请求 `live.douyin.com`，浏览器跨域读不到响应（Set-Cookie/HTML）。Electron 渲染进程关闭 webSecurity 虽可绕过，但属于全局降险，不可取。
2. **签名**：signature 需要执行抖音 Acrawler（sign.js）。技术上 sign.js 可在渲染进程执行（纯 JS），但 1 已阻断前置数据获取，签名无从谈起。
3. **Cookie 注入**：WebSocket 握手需带 `ttwid` Cookie，浏览器 JS 无法为第三方域设置 Cookie；Node `ws` 可自由设置 header。

→ 因此定为 **主进程 bridge 模式**：主进程完成全部协议工作，把结构化事件推给渲染进程。接口约定见 `sources/douyin.js` 文件头注释（`connect` / `disconnect` / `onEvent` / `offEvent`）。

## 6. 主进程实现清单（集成阶段 TODO）

- [ ] `main/douyin-bridge.js`：ipcMain.handle('douyin-bridge', action, payload) + ipcMain.on('douyin-event') 推送
- [ ] preload：`contextBridge.exposeInMainWorld('douyinBridge', ...)`；onEvent 回调用 ipcRenderer.on 转发（contextBridge 传函数受限，最新 Electron 支持 function 参数透传，可直接传）
- [ ] 下载 `douyin.proto` + `sign.js` 入库（`src/live/vendor/` 或 `main/vendor/`）
- [ ] 实现 §1 流程①~⑧（依赖：ws / protobufjs，zlib/crypto 内置）
- [ ] 事件归一化为 `{kind:'message'|'gift'|'enter'|'follow'|'notice', user?, text?, gift?, count?}` 回推
- [ ] 断线重连（指数退避，可选：重取 ttwid/签名）
- [ ] 风险提示：抖音随时可能升级签名算法（历史上 X-Bogus → a_bogus → msToken 校验多次变更），签名失效表现为 wss 握手直接关闭，需跟踪上游仓库更新 sign.js
