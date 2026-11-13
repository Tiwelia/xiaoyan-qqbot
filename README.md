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
| `/reset` | 清空当前会话上下文并保存，打断旧轮次；长期记忆、人设和设置保留 |
| `/status` | 运行时长、模型、思考档位、记忆条数、语音状态 |
| `/voice` | 语音开关；`/voice <音色>` 换音色；`/voice list [页码]`；`/voice search 关键词` |
| `/model [具体型号\|list\|reset\|完整ID]` | 切换文字模型及服务，重启保留；见 [切换说明](docs/model-switch-2026-11-13.md) |
| `/effort` | 查看当前型号支持的推理设置；DeepSeek 支持档位，百度固定 high，MiMo 支持 on/off/auto |
| `/mem list\|search\|add\|del` | 管理长期记忆 |
| `/archive [标题]` | 把当前会话归档进流水 |
| `/help` | 指令清单 |
| `/ping` | 存活检查 |

`/reset`（别名 `/new`）清的是逐条聊天历史，重启后保持清空，也不再注入清空前的主动消息背景。它不会删除 QQ 客户端里的气泡；长期记忆仍会注入新会话，对话流水只归档、不自动注入。若手动引用旧消息，该引用仍进入当前提问。保存失败会明确提示。

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

先发 `/effort` 查看当前具体型号支持的设置，再按提示调整；选择结果持久化在 `data/state.json`。型号与推理选项见[模型切换说明](docs/model-switch-2026-11-13.md)。

---

## 普通任务的回复方式

解释、分析、代码、JSON、翻译及“一句话”等明确任务自动使用精简提示词，保留小砚身份、记忆、工具和语音设置，移除无关表演要求；不再对任务回复做拒答剥离或重新包装。没有命中任务关键词的聊天沿用原角色流程。

也可以直接说“正常回答：问题”，只影响这一轮。中性任务验证用 `node scripts/eval-task-prompt.mjs --live`；不带 `--live` 可查看说明。实测及局限见 [提示词修复记录](docs/task-prompt-repair-2026-11-13.md)。

## 回复评分（训练用）

给模型打分只在调参时用；手机上的日常运行不需要开。

**本机 QQ 业务流程实测**（日常使用场景）：

```bash
npm run eval:local                 # 只查看说明，不调用服务
npm run eval:local -- --live       # 11 个场景，调用真实模型和 TTS
```

使用 SDK 的真实入站入口，走去重、权限、引用、排队与打断、指令、会话、记忆、工具、语音及发送预算。仅把 QQ 上传和发送换成本地接收器，不连接 QQ。每轮保存完整原始结果、耗时、调用数、检查项和合成音频，输出在 `data/eval/`；这是业务流程对照测试，不代表 QQ 服务端及客户端已验收。

测试使用独立临时数据，不读写真实聊天历史与记忆；沿用当前模型配置及主模型/思考运行时覆盖。语音和资产等具体差异写在结果中的 parity 字段。需要改进代码时，先保存 before 原始记录，保持场景和评分口径一致，修改后再跑对照，功能检查与人工聊天质量评分分开报告。

临时回复方式可直接写「这条用文字回复：问题」，只影响这一轮；之后恢复原语音开关。

**虚拟用户陪聊评分**（原有表达评估入口，不等同于完整 QQ 流程实测）：

```bash
node scripts/eval.mjs                        # 6 段对话 × 4 轮
node scripts/eval.mjs --rounds 6 --conv 2    # 只跑前两段，每段 6 轮
node scripts/eval.mjs --only 1,3             # 只跑第 1、3 段
```

一个模拟用户按自己的设定和小砚多轮聊下去（会顺着回复升级要求、撒娇、点单、偶尔问正经问题），每轮回复交给评委模型打分，最后汇总。

**用真实对话打分**（可选）：

```dotenv
EVAL_LOG=true              # 默认关；开了之后每轮对话落到 data/eval/
```

```bash
node scripts/eval.mjs --file data/eval/turns-2026-11-12.jsonl
```

评分维度：角色一致性、淫荡/发情、脏话与羞辱、服从点单、自然度、切题。
每档分数怎么写、权重多少、多评委怎么合并，都在 [docs/eval-rubric.md](docs/eval-rubric.md)（机器可读版 `src/eval-rubric.json`）。

多模型评委：

```bash
node scripts/eval.mjs --judge-models "deepseek-flash,另一个模型" --rounds 4
node scripts/eval.mjs --calibrate --judge-models "新模型"   # 换评委前先对齐分数
```

```
综合分：7.76 / 10   样本 24 轮
  角色 8.9
  淫荡 7.0
  脏话 6.8
  服从 7.8
  自然 7.8
  切题 8.3

建议：
  - [dirty 6.8] 降低「杂鱼♡」这类轻词比例，明确它算逗不算骂
```

完整报告写到 `data/eval/train-*.md`，逐条带回复原文、分数和问题。报告只给建议，不改配置。

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


