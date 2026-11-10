# Altare 部署与更新

## 当前状态

- 服务器：QQBot，Bangkok。免费额度：**6 GiB 内存 / 150% CPU / 10 GB 磁盘 / 最多 4 个实例**。
- 镜像：`ghcr.io/pelican-eggs/yolks:nodejs_24`（Node.js 24.22.2 / npm 12.2.1 已确认）。
- 用户确认旧记忆和旧聊天都是测试数据，本次不迁移；今后的新记忆和会话照常保存。
- 程序已上传并通过配置自检（`--check`）；**真实 QQ 连接、模型回复、重启持久化仍待验收**。

## 上传程序

```sh
npm run pack:altare
```

上传 `dist/xiaoyan-qqbot-altare.zip`，解压到 Altare 服务器根目录。
根目录应直接存在 `altare.js`、`package.json`、`src/`；不要套一层项目目录。
包内**不含 `.env`**、`data/`、`node_modules/`，后续更新不会覆盖服务器上的配置和数据。

**服务器上第一次部署必须单独放一份 `.env`**（包里没有），三种做法任选：

1. 把本机项目根目录的 `.env` 用面板文件管理器上传到应用根目录（最省事，和本地完全一致）；
2. 或者按 `.env.example` 在 Altare 的 Startup 变量里逐条填（变量名一致，程序会读 `process.env`）；
3. 两者都有时以 Altare 变量优先 —— `altare.js` 先 `loadEnvFile`，环境变量已存在则不会被覆盖。

至少要有：`QQBOT_APPID`、`QQBOT_SECRET`、`DEEPSEEK_API_KEY`、`TTS_ENABLED=true`、
`TTS_ENGINE=qwen`、`TTS_QWEN_API_KEY`。

## 数据目录（首次启动自动创建）

```text
data/
├── memory/xiaoyan-memory.db   长期记忆（importance + 对话流水）
├── sessions/*.json            每个会话一个文件
├── state.json                 模型覆盖、每个会话的语音开关与音色
├── owner.json                 首次绑定的主人账号（只在首次绑定时创建）
├── tmp/tts/                   临时音频：发完即删，TTL 60 分钟兜底，上限 256 MB
└── voice/cloned.json         自己复刻的音色（scripts/voice-clone.mjs 写入）
```

`.env` 里的路径：

```dotenv
DATA_DIR=./data
SESSION_DIR=./data/sessions
MEMORY_DB=./data/memory/xiaoyan-memory.db
MEMORY_SEED=
STATE_FILE=./data/state.json
TTS_TMP_DIR=./data/tmp/tts
TZ=Asia/Shanghai
```

`altare.js` 会拦住指到项目目录外的路径（Railway 的 `/data`、Windows 盘符路径都算）。

## 启动命令

“启动 → 命令与图像”里先用自检：

```sh
npm ci --omit=dev --no-audit --no-fund --registry=https://registry.npmjs.org && node altare.js --check
```

看到「Altare 配置检查通过（未连接 QQ、未调用模型）」后退出属正常。正式上线换成：

```sh
npm ci --omit=dev --no-audit --no-fund --registry=https://registry.npmjs.org && node altare.js
```

保持 Node.js 24 镜像。此命令直接运行 JavaScript，不走模板里的 ts-node 分支。
机器人用出站 WebSocket，不需要开网站或入站端口。

## 首次绑定主人（更新后先做一次）

正式启动时，如果没有 `OWNER_OPENID` 且服务器还没有 `data/owner.json`，控制台会打印随机的 `/bind ...` 指令。
在十分钟内用自己的 QQ **私聊**机器人发送这一整条指令。未绑定消息不进入模型或记忆处理；
绑定后只处理该账号的消息，其他账号无法读删记忆、修改模型或使用付费语音。
绑定码只在控制台显示，不要转给其他人；过期后重启机器人会重新生成。

绑定结果保存在 `data/owner.json`，重启和上传更新包均不需要重新绑定。
如果已知自己的机器人用户 OpenID，可在服务器 `.env` 设置 `OWNER_OPENID=...` 直接指定。
这里需要消息事件里的用户 OpenID，不能填 QQ 号。保留 `data/` 和 `.env`，不要用本地测试数据覆盖它们。

**为什么有时候又要重新绑？** 只有一个原因：服务器上的 `data/owner.json` 丢了。常见是面板里「Reinstall / 重装」把整个容器目录清空，或者解压新包时把 `data/` 一起覆盖了。两条防法（建议都做）：

1. 绑定成功时控制台会打印 `主人绑定已保存：<openid>`，把那一串抄进 `.env` 的 `OWNER_OPENID=`，以后就算 `data/` 没了也不用再绑；
2. 上传新包时**只覆盖程序文件**（`src/`、`scripts/`、根目录的 `.js`/`.json`/`.md`），不要动 `data/` 和 `.env`。
`C2C_MODE=open` 仍受主人门禁约束；本项目仅供主人私聊使用，不接收群聊或其他账号的消息。

## 主动聊天验收

这版默认启用自然聊天和主动找话题。保留服务器原来的 `.env` 和 `data/`，上传新程序并重启后，先正常私聊一句。
在 QQ 的机器人资料/设置里允许主动发送；默认每天最多 4 次、北京时间 23:00～09:00 免打扰，没有回复不追发。
主动消息与被动回复额度分开，正常检查不调用模型，真正尝试找话题才生成一次短文字。

先发「先别主动找我」，再用 `/status` 确认关闭；发「恢复主动聊天」后确认开启。
正常对话结束约 90～180 分钟后才会考虑主动联系，也可能因没有新话题而跳过。
收到一条后不回复，确认不连续追发；重启后再用 `/status` 确认计数与等回复状态仍在。
若提示主动发送无权限/拒收，先检查 QQ 客户端开关与平台权限，修复后说「恢复主动聊天」。
离线测试不能代替上述真实 QQ 验收。

## 语音（TTS）上线步骤

1. `.env` 加 `TTS_ENABLED=true`、`TTS_ENGINE=qwen` 和 `TTS_QWEN_API_KEY`（百炼的 key）。
2. 音色两种来源：
   - 系统音色：88 个，`/voice list` 看全部，`node scripts/voice-preview.mjs <id>` 试听
   - 复刻音色：`node scripts/voice-clone.mjs 你的录音.m4a --name 软糖`，之后 `/voice 软糖`
3. 重启后在私聊发 `/voice` 打开语音（再发一次就是关），让它念一句验证。
   开着时每条回复都会念，**不需要任何额外指令**：短回复一段一条；长回复整段合成后按 20MB 软上限
   切成几条语音条（10 分钟 24kHz 是 2 条，20 分钟降到 16kHz 仍是 3 条），总字数由 `TTS_MAX_CHARS`
   卡（默认 2400 字 ≈ 8 分钟）。想一上来就开就设 `TTS_DEFAULT_ON=true`。
   默认关闭输入中提示；即使服务器旧配置仍开启，语音回复也会跳过提示。语音开启时会预留一次发送额度：
   非流式发送且没有其他媒体占额时，最多三块文字（每块 4500 字）加一条合并语音。
   想打断它，**直接发下一条消息**就行（会取消当前任务和已排队消息）；`/stop` 只是"不想说话只想停"时的兜底。
   已进入腾讯发送接口的消息无法撤销。
   记忆默认走严格模式（`MEMORY_STRICT=true`）：禁 event、加禁止清单、近似去重、200 字封顶。
4. `/status` 能看音频闸门：在跑 / 排队 / 临时盘占用。队列满了会回「忙」，不会把内存堆爆。

## 长语音

**不用发任何指令**：语音开着，让它"念一段雨夜的场景"，它写多长就念多长（受 `TTS_MAX_CHARS` 限制），
长音频自动拆成几条语音条发出来。音色、人设、语气都沿用当前会话设置。

`/long [分钟] [主题]` 仍保留为隐藏兜底（不想自己打字、让它按主题自己写稿时用），不进帮助列表。
它单独使用 `LONG_REPLY_TIMEOUT_MS=900000`，普通聊天仍是 `REPLY_TIMEOUT_MS=240000`。

时长是按字数估算的（`TTS_CHARS_PER_SECOND`，默认 4.9 字/秒），实际以生成音频为准。
Qwen 的 `TTS_STYLE` 默认留空（加了会毁韵律），加戏靠正文里的官方标签，停顿由 SSML 自动补。此功能只合成语音，
不添加真实雨声、音乐或立体声效果。

合成时保留上游采样率，优先按 18MB 单条预算分成最多三条语音；原音质装不下剩余条数时才降采样。
`TTS_LONG_DELIVERY=file` 可改成发完整 WAV 文件。仍受单段字节、整段 64MB 和临时盘 256MB 约束。
长音频在 QQ 客户端的播放效果需要上线试听确认。

语音引擎只有 Qwen（阿里云百炼）：`qwen-audio-3.1-tts-flash`，默认音色 `longanlingxin_v3.1`（龙安灵心）。
key 走 `.env` 的 `TTS_QWEN_API_KEY`；`TTS_SSML=true` 会自动按句补停顿，`TTS_STYLE` 留空（加了反而毁韵律）。
自己的声音用 `scripts/voice-clone.mjs` 复刻成音色，登记后 `/voice <名字>` 直接用。

## 长语音

**不用发任何指令**：语音开着，让它"念一段雨夜的场景"，它写多长就念多长（受 `TTS_MAX_CHARS` 限制），
长音频自动拆成几条语音条发出来。音色、人设、语气都沿用当前会话设置。

`/long [分钟] [主题]` 仍保留为隐藏兜底（不想自己打字、让它按主题自己写稿时用），不进帮助列表。
它单独使用 `LONG_REPLY_TIMEOUT_MS=900000`，普通聊天仍是 `REPLY_TIMEOUT_MS=240000`。

时长是按字数估算的（`TTS_CHARS_PER_SECOND`，默认 4.9 字/秒），实际以生成音频为准。
Qwen 的 `TTS_STYLE` 默认留空（加了会毁韵律），加戏靠正文里的官方标签，停顿由 SSML 自动补。此功能只合成语音，
不添加真实雨声、音乐或立体声效果。

合成时保留上游采样率，优先按 18MB 单条预算分成最多三条语音；原音质装不下剩余条数时才降采样。
`TTS_LONG_DELIVERY=file` 可改成发完整 WAV 文件。仍受单段字节、整段 64MB 和临时盘 256MB 约束。
长音频在 QQ 客户端的播放效果需要上线试听确认。

引擎只有 Qwen（阿里云百炼）：`qwen-audio-3.1-tts-flash`，默认音色 `longanlingxin_v3.1`（龙安灵心）。
key 走 `TTS_QWEN_API_KEY`；`TTS_SSML=true` 按句自动补停顿（`TTS_PAUSE_MS=600`），`TTS_STYLE` 留空。
自己的声音用 `scripts/voice-clone.mjs` 复刻成音色，登记后 `/voice <名字>` 直接用。实测输入不过内容过滤。

资源上限按「个人单聊 + 6 GiB / 150% CPU / 10 GB 盘」给的默认值，可在 `.env` 调：

| 变量 | 默认 | 作用 |
|---|---|---|
| `TTS_MAX_CONCURRENCY` | 3 | 同时合成路数 |
| `TTS_QUEUE_MAX` | 8 | 允许排队的路数，超了直接拒 |
| `TTS_TIMEOUT_MS` | 30000 | 单次合成超时 |
| `TTS_MAX_CHARS` | 2400 | 一次最多念多少字（≈8 分钟） |
| `TTS_MAX_BYTES` | 4 MB | 单条音频体积上限 |
| `TTS_COOLDOWN_MS` | 2000 | 同一会话的冷却 |
| `TTS_TTL_MINUTES` | 60 | 临时音频兜底保留时长 |
| `TTS_TMP_MAX_MB` | 256 | 临时目录总配额（10 GB 盘里的一小块） |

## 单聊模式

```dotenv
SCOPE_MODE=c2c          # 只收私聊；群里被拉进去也不应答
GROUP_MODE=disabled     # 与 SCOPE_MODE=c2c 必须一致，否则配置自检拦下来
```

以上配置保持不变。个人专用版不挂载群聊旁听中间件，入口始终忽略非私聊消息；
旧配置若写成 `SCOPE_MODE=both` 或 `GROUP_MODE=open`，启动检查会要求改回。

## 长语音与表情包

- 长语音不用指令：语音开着，写多长念多长，按体积切成几条语音条（单聊额度 4 次）。
  10 分钟是 2 条 24kHz 语音条；20 分钟降到 16kHz 仍是 3 条；再长才 12kHz。
- QQ 语音条的软上限是 **20MB**（超了平台自动降级成文件卡片），没有时长限制——
  所以"能不能发十分钟"只取决于体积，本项目会自动切段。
- 表情包：把 png/jpg/gif/webp 丢进 `data/assets/`，文件名就是名字，模型会自己挑着发。

## 场景音频（可选）

`SCENE_ENABLED=true` 时，模型可以用 `audio_scene` 生成带环境音的场景（雨声、雷、呼吸、耳语），
单次 ≤120 秒，key 复用 `TTS_QWEN_API_KEY`。生成耗时约等于音频时长 ×1.3（60 秒音频要等 84 秒左右），
回合内会占一条语音额度和一次被动回复。不想要就设 `SCENE_ENABLED=false`。

## 语音报 `fetch failed` 怎么查

典型日志：

```
[WARN] 语音合成失败：fetch failed
12:39:27 发起 → 12:39:37 失败          ← 正好 10 秒 = undici 连接超时
```

这说明**请求没连上阿里云**，不是 key 或模型的问题。把启动命令临时换成诊断脚本，重启一次：

```sh
node scripts/net-check.mjs
```

它会依次打印 DNS → TCP 443 → TLS → 真实合成请求，哪一步 ❌ 就是原因：

| ❌ 在哪一步 | 说明 | 处理 |
|---|---|---|
DNS 解析 | 容器拿不到域名 | 面板网络/DNS 问题；换 `--host dashscope-intl.aliyuncs.com` 试 |
TCP 443 | 出网被挡（Bangkok → 阿里云国内节点） | 放行出网，或换国际站 key + `TTS_QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/api/v1` |
TLS | 证书/中间人 | 检查容器时间、代理 |
HTTP 401 | key 与地域不匹配 | 国内 key 只能打 `dashscope.aliyuncs.com`，国际 key 只能打 intl |
HTTP 429 / 5xx | 限流或服务端抖动 | 程序已自动重试 3 次（600ms / 1800ms 退避） |

程序本身也会重试网络层错误，并把真实原因写进日志：
`qwen TTS 连不上 https://dashscope.aliyuncs.com/api/v1：fetch failed（UND_ERR_CONNECT_TIMEOUT dashscope.aliyuncs.com）`

### Engine error [411] 的自动降级

国际站上偶尔会返回：

```
400 {"code":"InvalidParameter","message":"[cosyvoice:]Engine error [411]: TTS speak operation failed"}
```

这有三种常见诱因，程序会按顺序自动降级（每步只试一次）：

| 顺序 | 触发条件 | 动作 |
|---|---|---|
1 | 请求带了 SSML（`enable_ssml`） | 去掉 SSML 换纯文本重发 |
2 | 请求带了 `instruction`（风格指令） | 去掉 instruction 重发 |
3 | 音色不是默认音色 | 换默认音色重发 |
4 | 用的是 `-plus` 模型 | 落回 `-flash` |
5 | 以上都不是（纯瞬时故障） | 等 800ms 原样重试一次 |

所以日志里会先看到一条 WARN 再看到「语音合成完成」——那是降级成功，不是失败。
真失败时（五步都过不去）才会回「语音没合成出来」。

### 国际站 vs 国内站（2026-11 实测）

| | 国内站 `dashscope.aliyuncs.com` | 国际站 `dashscope-intl.aliyuncs.com` |
|---|---|---|
境外服务器直连 | ❌ 10 秒连接超时 | ✅ 正常 |
key | 只认国内站 key | 只认国际站 key |
系统音色 | 88 个 | **只有少数几个**：`longanlingxin_v3.1` `longanhuan_v3.1` `longanfengyue_v3.1` `xunanchuan_v3.1` 实测可用；`anruorou` `guyunshu` `xuxiaoqiao` 等会 400 |
声音复刻 | 支持 | 支持（同一个 `/services/audio/tts/customization`） |
SSML + 官方标签 | 支持 | 支持 |

程序已做兜底：请求的音色在该端点不存在时，自动改用默认音色重念并记一条 warn，不会整段失败。
所以境外部署建议默认音色就用上面那几个之一（当前 `longanlingxin_v3.1` 正好可用）。

### 为什么本机能用、服务器不行

本机（国内网络 + 代理）能连上，服务器（境外直连）超时，这是**跨境直连不通**，不是 key 或代码问题。
判断方法：`nslookup dashscope.aliyuncs.com` 如果解析到 `198.18.x.x`，说明本机走的是代理的 fake-ip，
真正的出网是代理在做。

两条可行路线：

**A. 换阿里云国际站（境外服务器推荐，直连低延迟）**

1. 在阿里云**国际站**（alibabacloud.com）开通百炼，拿一个国际站 key
2. `.env` 改成：

```dotenv
TTS_QWEN_API_KEY=<国际站 key>
TTS_QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/api/v1
```

3. 先验一下：`node scripts/net-check.mjs --base https://dashscope-intl.aliyuncs.com/api/v1`

注意国内 key 打 intl 会 401，国际 key 打国内站也会 401，两者不通用。

**B. 让容器走代理（如果你有境外代理节点）**

Node 24 支持从环境变量读代理：

```dotenv
HTTPS_PROXY=http://代理地址:端口
```

启动命令换成（多一个 flag）：

```sh
node --use-env-proxy altare.js
```


## 上线验收


1. 控制台出现「QQ 机器人已上线」且「记忆库就绪」（没有「已降级」）。
2. 手机 QQ 私聊发一条，确认回复；等 3 秒再发一条，确认上下文连着。
3. 发一张图，确认不是「没开图片识别」那种降级文案。
4. 让它记一条：`/mem add rule 测试记忆`，`/reset` 后重启服务，`/mem list` 仍能看到。
5. `/status` 看语音闸门与临时盘；`/voice on` 后让它念一句，确认收到语音条。
6. 重启 Altare，确认 `data/` 里的会话与记忆还在；`data/tmp/tts/` 里没有残留音频。
7. 后续更新只换程序文件，别动 `.env` 和 `data/`。

## 已修复的问题

- npm 12 的 EALLOWREMOTE：锁文件下载地址已统一为 npm 官方仓库，保留 `.npmrc` 与 `package-lock.json`。
- 默认启动模板错误使用 ts-node：使用上面的直接启动命令。
- 迁移版丢功能：引用回复、指令系统、语音、记忆分档、群聊长回复截断、图片判定、记忆脏数据，均已补回。




