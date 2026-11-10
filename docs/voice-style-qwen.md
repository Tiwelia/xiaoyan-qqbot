# Qwen TTS 风格指令手册（qwen-audio-3.1-tts-flash / -plus）

> 适用：`TTS_ENGINE=qwen`。这份是给人看的完整版；模型在语音开着时会收到一份精简版
> （`src/voice-style.js` → `QWEN_GUIDE`），两边保持同一套规矩。

## 一、接口长什么样

```
POST https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer
{
  "model": "qwen-audio-3.1-tts-flash",
  "input": {
    "text": "要念的正文",
    "voice": "anruorou_v3.1",
    "instruction": "气声、语速很慢、贴着耳朵说话",
    "format": "wav",
    "sample_rate": 24000
  }
}
```

- `voice`：系统音色 id，88 个可选（`/voice list`）。
- `instruction`：**一句话**风格指令，就是本项目的 `TTS_STYLE` 或 `tts_speak` 的 `style`。
- 输出 24kHz 单声道 16bit wav。

## 二、instruction：默认别用

实测结论：**instruction 会让长文本的音量和韵律中途跳变**——同一段话里前半句是气声、后半句切回实声，
再加上我们按段合成，接缝处更明显。听起来像中途换人，也像音量忽大忽小。

所以本项目 `TTS_STYLE` 默认留空，不发 instruction。想调语气请走第三节的标签。

如果一定要写，就写一句短的（别写成导演稿）：`气声、语速很慢`。它只适合很短的句子。

## 三、正文里的标签：英文的能用，中文的别用

Qwen 官方支持在正文里插**英文方括号标签**，会真的演出来（控制类标签作用到下一个标签为止）：

| 类别 | 标签 |
|---|---|
情绪 | `[excited]` `[angry]` `[sad]` `[tired]` `[bored]` `[curious]` `[serious]` `[sarcastic]` `[scornful]` `[panicked]` `[reluctantly]` `[empathetic]` `[mischievously]` `[amazed]` |
拟声 | `[laughing]` `[giggles]` `[crying]` `[sighing]` `[gasp]` `[cough]` `[clears throat]` `[snorts]` |
质感/强度 | `[whispers]` `[shouting]` `[deep and loud shouting]` `[trembling]` `[asmr]` `[like dracula]` `[very slowly]` `[very fast]` |

写法：`[whispers]嘘，别说话[excited]走吧走吧`

**中文括号（小声）（语速加快）不要写**——它不是标签，会被当正文念出来：同一句话纯净 3.68 秒、
带中文括号 5.92 秒，多出来的两秒就是被念的提示词。本项目会把中文提示剥掉，但剥完容易让句子断层，
不如一开始就写对。

**停顿不用你管**：项目开了 TTS_SSML，会按句号/问号/省略号自动插 <break>（省略号后停 1.5 倍）。
所以你只要按人话写标点，别为了拖节奏故意断句。一段里放 3～6 个标签就够，情绪转折处放一个最有效。

> 注意：本项目只保留上表里的标签（大小写会自动归一），`[foo]` 这种不认识的英文标签会被当成无效标签去掉；
> 含中文或数字的方括号（如 `[1]`）原样保留。

## 四、音色怎么选

- 只能从系统音色里挑，写别的名字直接 400。
- 当前默认 `anruorou_v3.1`（安若柔，气声 + 知性），最贴 ASMR。
- 几个常用：`xuxiaoqiao_v3.1`（徐小俏，自然俏皮）、`anmingyuan_v3.1`（安明远，男，清亮自然）、
  `longanhuan_v3.1`（龙安欢，活泼女声，也是 `-plus` 档少数能用的音色之一）。
- `-plus` 档只认 `longanlingxin` / `longanhuan` / `longanfengyue` 三个音色，选到别的会自动降到 `-flash`。

## 五、ASMR 场景可直接用的两套

**贴耳低语**

```
voice: anruorou_v3.1
instruction: 气声、语速很慢、贴着耳朵说话、尾音拖长、情绪克制
text: [whispers]你还没睡啊……[sighing]我把被子给你拉上来一点，别着凉。
```

**情绪起伏**

```
voice: xuxiaoqiao_v3.1
instruction: 半气声、语速先慢后快、情绪从嘴硬到发颤
text: 谁、谁稀罕你哄啊。你别靠这么近……
```

## 六、常见错误

| 错误 | 结果 |
|---|---|
instruction 写成一整段导演稿 | 被当风格文本，效果反而不如一句话 |
| 正文里写中文（小声）（叹气） | 被念出来；本项目会剥掉但容易断句，改用 `[whispers]` `[sighing]` |
写了不存在的音色名 | 400；本项目会先在 /voice 那一步挡下来 |
把 `-plus` 和任意音色混用 | 400；本项目会自动降到 `-flash` 重试 |




## 拟声词与省略号（2026-11-10）

中文 TTS 念单个「嗯」再补停顿，听起来是「嗯。……」，不是拖长。所以在生成 SSML 时做了两件事：

- `嗯……` / `啊……` / `哈……` / `呜……` → 先写成 `嗯——`（破折号会被读成拖音），后面再跟一个 `break`（约 0.69 秒）；
- 其它位置的 `……` → 换成 `break`（约 0.45 秒），不读音；
- `～` / `~` → 换成半拍 `break`（约 0.33 秒）。

对应函数：`src/tts.js` 的 `punchInterjection()`，在 `toSsml()` 里逐句调用。
人设层也要配合：写「嗯……」「啊——」这种，别写「（停顿两秒）」。
