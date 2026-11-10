# xiaoyan-qqbot · QQ 单聊机器人

一个跑在单台服务器上的 QQ 机器人：官方机器人 SDK 直连，兼容 OpenAI 的模型做对话，阿里云百炼 Qwen 做语音合成，带长期记忆、联网查询和定时主动消息。

单进程，两个运行时依赖，Node.js 24 起。数据全部落在项目目录内（`./data`）。

---

## 功能

| 模块 | 说明 |
|---|---|
| 对话 | 兼容 OpenAI Chat Completions 的服务；默认 DeepSeek，可切 OpenRouter / OpenAI |
| 语音 | Qwen TTS，支持 SSML 停顿、官方语气标签、长文本自动分条、声音复刻 |
| 记忆 | SQLite 双库：重要事实 + 对话流水，按作用域分档注入 |
| 联网 | 天气、网页搜索、抓取网页正文；带超时、取消和私网拦截 |
| 主动消息 | 空闲 90～180 分钟后考虑发一条短消息，每天上限 4 条，夜间免打扰 |
| 指令 | `/` 前缀指令 + 等价的中文自然语言说法，均不进模型 |
| 会话 | 按联系人保存上下文；新消息打断上一轮，不需要 `/stop` |

机器人只接受已绑定账号的私聊。绑定通过控制台一次性生成的随机码完成。

---

## 架构

```
QQ 网关（WebSocket）
      │
      ▼
消息过滤 → 权限校验 → 限流/去重 → 指令分流
                                      │
                    ┌─────────────────┴─────────────────┐
                    ▼                                   ▼
              指令直接返回                       组装 system prompt
                                          （权限声明 + 约束层 + 角色设定 + 工具说明）
                                                        │
                                                        ▼
                                              模型（流式，可调思考档位）
                                                        │
                                          ┌─────────────┴─────────────┐
                                          ▼                           ▼
                                    工具调用（记忆/语音/联网）      正文
                                          │                           │
                                          └─────────────┬─────────────┘
                                                        ▼
                                          文本 / 语音条 / 图片（共用被动回复额度）
                                                        │
                                                        ▼
                                              写入会话与记忆
```

发送额度是全局的：单聊 60 分钟内最多 4 条，文本、语音、图片、文件共用这一个预算。语音轮次会预留额度，长语音按体积拆成多条。

---

## 目录

```
altare.js              入口：加载 .env、校验配置、启动服务
src/
  index.js             组装依赖、注册事件、优雅退出
  bot.js               QQ 事件、打断、限流、会话键
  conversation.js      一轮对话：指令 → 模型 → 工具 → 发送
  persona.js           system prompt 分层与角色设定
  chat-style.js        闲聊的表达习惯（与角色设定分离）
  llm.js               模型客户端：provider 适配、流式解析、参数回退
  tools.js             工具注册与执行
  web.js               联网请求：校验、重定向、取消、限流
  tts.js               Qwen/OpenAI 语音合成、SSML、并发闸门
  audio.js             WAV 解析、拼接、降采样
  delivery.js          被动回复预算与长语音分条
  memory.js            SQLite 记忆库
  session.js           会话上下文缓存
  companion.js         主动消息调度
  commands.js          指令与自然语言设置解析
  owner.js             首次绑定
  state.js             运行时状态持久化
scripts/               测试、打包、声音复刻、联网诊断、模型能力探测
docs/                  语音风格手册与修复记录
```

---

## 快速开始

要求 Node.js ≥ 24（使用内置 `node:sqlite`）。

```bash
npm ci
cp .env.example .env      # 填写 QQBOT_APPID / QQBOT_SECRET / 模型 key
node altare.js            # 或 npm start
```

首次启动时控制台会打印一条 `/bind <随机码>`。用要绑定的 QQ 账号私聊机器人发送这条指令，十分钟内有效。绑定结果保存在 `data/owner.json`。

上线前可以先做离线自检：

```bash
node altare.js --check     # 只校验配置，不连接 QQ、不调用模型
```

---

## 配置

所有配置走环境变量或 `.env`，完整清单见 `.env.example`。常用项：

### 机器人

| 变量 | 默认 | 说明 |
|---|---|---|
| `QQBOT_APPID` / `QQBOT_SECRET` | — | QQ 开放平台机器人凭证 |
| `OWNER_OPENID` | 空 | 直接指定绑定账号，省掉 `/bind` |
| `DATA_DIR` | `./data` | 数据目录（会话、记忆、临时音频） |
| `TZ` | `Asia/Shanghai` | 日志与提示词时区 |

### 模型

| 变量 | 默认 | 说明 |
|---|---|---|
| `LLM_BASE_URL` | `https://api.deepseek.com` | 兼容 OpenAI 的接口地址 |
| `LLM_PROVIDER` | `auto` | `auto` / `deepseek` / `openrouter` / `openai` / `generic` |
| `LLM_MODEL` | `deepseek-flash` | 主模型 |
| `LLM_API_KEY` | 空 | 通用 key；留空时按 provider 取专用 key |
| `LLM_VISION_MODEL` | `deepseek-flash` | 视觉模型；显式留空即关闭图片理解 |
| `LLM_THINKING` | `auto` | `auto` / `enabled` / `disabled` |
| `LLM_EFFORT` | 空 | `off` / `low` / `high` / `max` |
| `LLM_MAX_TOKENS` | `8192` | 单轮输出上限 |

专用 key：`DEEPSEEK_API_KEY`、`OPENROUTER_API_KEY`、`OPENAI_API_KEY`。视觉路由可以单独指定 `LLM_VISION_PROVIDER` / `LLM_VISION_BASE_URL` / `LLM_VISION_API_KEY`，与主聊天互不借用凭证。

### 语音

| 变量 | 默认 | 说明 |
|---|---|---|
| `TTS_ENABLED` | `true` | 总开关 |
| `TTS_ENGINE` | `qwen` | `qwen` 或 `openai` |
| `TTS_QWEN_API_KEY` | 空 | 百炼 key（也认 `DASHSCOPE_API_KEY`） |
| `TTS_QWEN_BASE_URL` | `https://dashscope.aliyuncs.com/api/v1` | 境外部署改国际站 |
| `TTS_VOICE` | `longanlingxin_v3.1` | 默认音色 |
| `TTS_DEFAULT_ON` | `true` | 新会话默认开启语音回复 |
| `TTS_SSML` | `true` | 用 SSML 插入停顿 |
| `TTS_PAUSE_MS` | `600` | 基础停顿时长 |
| `TTS_MAX_CHARS` | `8000` | 单轮朗读上限 |
| `TTS_MAX_CONCURRENCY` | `3` | 并发合成数 |

### 主动消息

| 变量 | 默认 | 说明 |
|---|---|---|
| `PROACTIVE_ENABLED` | `true` | 总开关 |
| `PROACTIVE_DAILY_MAX` | `4` | 每天最多发送条数 |
| `PROACTIVE_MIN_IDLE_MINUTES` / `MAX` | `90` / `180` | 空闲多久后考虑 |
| `PROACTIVE_QUIET_START` / `END` | `23` / `9` | 免打扰时段 |

---

## 指令

指令在进入模型之前处理，不消耗 token。

| 指令 | 作用 |
|---|---|
| `/reset` | 清空当前会话上下文，不动记忆 |
| `/status` | 运行时长、模型、思考档位、记忆条数、语音状态 |
| `/voice` | 语音开关；`/voice <音色>` 换音色；`/voice list [页码]`；`/voice search 关键词` |
| `/model [名字\|reset]` | 查看或切换模型 |
| `/effort [off\|low\|high\|max]` | 查看或调整思考档位 |
| `/mem list\|search\|add\|del` | 管理长期记忆 |
| `/archive [标题]` | 把当前会话归档进流水 |
| `/help` | 指令清单 |
| `/ping` | 存活检查 |

以下说法等价于指令，整句匹配才生效：

- `打开语音` / `关闭语音` / `以后用文字回复`
- `音色换成 <名字>`、`查看音色`、`查看音色第 2 页`、`找音色：温柔`
- `查看设置`、`查看详细状态`、`查看帮助`
- `先别主动找我`、`恢复主动聊天`、`我先忙了`、`晚安`

带这些词的提问（例如「语音怎么老断」）不会被当成开关，正常进模型。

---

## 语音

- 语音开启时，回复默认只发语音条，不再重复一条同样的文字；代码块和链接自动改用文字。
- 合成失败会退回文字；超过朗读上限的部分以文字补发，不静默丢失。
- 长回复整段合成后按 20MB 软上限分条发送，额度不足时先降采样。
- 支持 Qwen 的 30 个英文语气标签，例如 `[whispers]`、`[sighing]`、`[asmr]`；中文括号会被照读，不用于标注。
- 拟声词会做拖音处理：`嗯……` 转成 `嗯——` 加停顿，避免听起来像「嗯。……」。

声音复刻：

```bash
node scripts/voice-clone.mjs 我的录音.m4a --name 名字    # 10~60 秒、≤10MB
node scripts/voice-clone.mjs --list
node scripts/voice-preview.mjs 名字
```

复刻音色绑定目标模型，登记信息在 `data/voice/cloned.json`。

境外部署注意：`dashscope.aliyuncs.com` 在国内可达、境外常超时；`dashscope-intl.aliyuncs.com` 反之。key 与站点绑定，换站要换 key。可用音色也不同，国际站实测支持 `longanlingxin` / `longanhuan` / `longanfengyue` / `xunanchuan`。

---

## 联网

三个只读工具，模型自行选择：

| 工具 | 用途 |
|---|---|
| `weather` | 实时天气与当日气温、降水 |
| `web_search` | 新闻、价格、资料（Bing 优先，DuckDuckGo 兜底） |
| `fetch_url` | 抓取网页正文，最多约 2500 字 |

限制：仅 http/https；拒绝私网与回环地址（含 IPv4 映射的 IPv6）；每个重定向跳转重新校验；DNS 结果固定到 socket，防止解析漂移；单次 9 秒超时、单页 1.5MB；请求随对话取消而中止。

---

## 模型切换

改三个变量即可换服务：

```dotenv
LLM_BASE_URL=https://openrouter.ai
LLM_PROVIDER=openrouter
LLM_MODEL=deepseek/deepseek-chat
```

换模型前建议先探测能力（接口本身不告知支持哪些参数）：

```bash
node scripts/probe-model.mjs
node scripts/probe-model.mjs --model deepseek-v4-pro
```

输出会逐项标明是否支持 `thinking`、`effort` 各档、是否为推理模型、能否看图。若模型不接受某个参数，客户端会在收到 400 后去掉该参数重试一次，并按模型记住，不影响其他模型。

思考档位可在聊天中调整：`/effort off|low|high|max`，选择结果持久化在 `data/state.json`。

---

## 测试与打包

```bash
npm test          # 全部离线测试，不连接 QQ、不调用付费接口
npm run check     # 语法检查
npm run selftest  # 模块自检
```

打包上传（Windows）：

```powershell
npm run pack:altare
# 输出 dist/xiaoyan-qqbot-altare.zip
```

压缩包不含 `.env`、`data/`、`node_modules/`、旧包与日志。

---

## 平台限制

来自 QQ 官方文档（2026-11 核对）：

- 被动回复：单聊 60 分钟内 4 条，群聊 5 分钟内 5 条，所有消息类型共用。
- 富媒体软/硬限制：图片 20/200MB，视频 30/200MB，语音 20/200MB，文件 200MB。
- 语音上传接受 silk / mp3 / wav / ogg。
- 主动消息需要客户端允许且机器人具备对应权限；发送失败会暂停 24 小时，可在聊天中说「恢复主动聊天」解除。

---

## 排错

| 现象 | 排查 |
|---|---|
| 启动即退出 | `node altare.js --check` 看缺哪项配置 |
| 语音 `fetch failed` / `ECONNRESET` | `node scripts/net-check.mjs --base <接口地址>` 逐步看 DNS、TCP、TLS、合成 |
| 日志时间差 8 小时 | 容器常把 `TZ` 设为 UTC 且优先级高于 `.env`，入口会强制覆盖，确认 `.env` 里 `TZ` 正确 |
| 语音连续失败 | 连续 3 次连不上会熔断两分钟，期间直接走文字 |
| 主动消息不发 | `/status` 看是否「等你回复中」或「上次发送失败 · 暂停到 …」 |
| 重新部署后要重新绑定 | `data/owner.json` 丢了；把绑定时的 openid 写进 `OWNER_OPENID`，并避免覆盖 `data/` |

---

## 说明

- 单用户设计：只处理已绑定账号的私聊，群聊入口默认关闭。
- `src/persona.js` 是示例角色设定，出场人物均为成年人；可以直接替换成自己的设定。
- 项目按个人自用维护，接口与默认值可能随上游服务变化而调整。
