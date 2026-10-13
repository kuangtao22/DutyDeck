---
name: media-models
description: 根据 DutyDeck 当前配置且可执行的媒体模型，生成或编辑图片、视频、语音、歌曲和音频；触发前先发现真实能力，不使用过期模型名、固定供应商或旧 Proma 生图 Skill。多产物和持续迭代任务转交 canvas-production。
group: proma
version: "1.0.0"
---

# 统一媒体模型

当用户要生成或编辑图片、视频、动图、旁白、语音、播客片段、歌曲、音乐或音效，或询问当前配置了哪些媒体模型时，使用本 Skill。它负责一次媒体任务的模型发现、能力匹配和生成交付。

## 触发边界

- 用户明确要求图片、图片编辑、视频、首帧/参考图生视频、语音、旁白、声音复刻、歌曲、音乐或音效。
- 用户询问“有哪些图片/视频/音频模型”“哪个模型能写歌/配音”，或指定供应商、模型、速度、成本、画幅、音色、格式等条件。
- 用户要一次独立媒体产物时使用本 Skill。
- 用户要产品套图、连续分镜、多个关联产物、持续迭代、画布节点、工作流、候选验收或采用时，读取并转交 `canvas-production`。
- 用户明确要求修改项目代码时，执行普通代码任务，不用媒体 Skill 替代实现。

## 第一步：发现所有真实模型

每次新的媒体任务都先调用 `media_list_models`，并按 `nextOffset` 分页直到返回 `nextOffset: null`。这个工具返回统一图片、音频和视频目录中的稳定 `ref`、`kind`、`capabilities`、`available`、`adapterId` 和不可用原因。

为了覆盖历史 API 媒体目录，再调用 `media_list_api_models`，同样分页读完。它可能返回已经配置但仍是 `configuration-only` 的条目；这类条目只能用来说明配置缺口，不能执行。两个结果按稳定引用、供应商、配置 ID 和模型 ID 去重，不能因为显示名称相同就合并不同模型。

统一生成链只把同时满足以下条件的条目作为执行候选：

- 统一目录：`available === true` 且存在 `adapterId`。
- API 目录：只有返回了该执行工具明确接受的稳定引用、`available === true` 且 `support.state === "supported"` 时才可执行；没有统一 `ref` 的 API 条目不能把 `profileId` 冒充 `modelRef`。
- 模型能力与用户意图匹配，不能把同一 `audio` 条目自动当成语音。

分页、过滤或去重失败时，保留错误并说明，不能把部分目录当成完整目录，也不能静默退回文本回答。

## 能力匹配

按返回的真实 `capabilities` 选择：

| 用户意图 | 必须匹配的能力 | 说明 |
| --- | --- | --- |
| 生成图片 | `text-to-image` | 文生图；有参考图时改用 `image-to-image` |
| 编辑图片 | `image-to-image` | 只使用已授权的媒体资产引用 |
| 生成视频 | `text-to-video` | 用户给首帧或参考图时使用 `image-to-video` |
| 生成语音、旁白、播客片段 | `text-to-speech` | 需要声音样本时必须有 `voice-cloning` |
| 声音复刻 | `voice-cloning` | 需要已授权的音频资产，不能把本地路径直接传给工具 |
| 写歌、生成音乐或音效 | `text-to-music` | 只有真实返回该能力且可执行的模型才可使用 |

`text-to-music` 目前可能只出现在配置目录的 `configuration-only` 条目中。遇到这种情况要明确告诉用户：模型已配置，但 DutyDeck 当前没有对应执行 adapter；不要把 TTS 模型、LLM 或旧图片模型冒充音乐模型。若没有任何可用候选，说明缺少的能力、已有但不可用的模型及原因，并引导用户到媒体设置补齐配置。

## 选择规则

1. 用户明确指定 `modelRef/ref`、供应商或模型名时，优先精确匹配当前目录；找不到就说明当前配置没有该模型，不猜测相似名称。
2. 用户未指定模型时，在可执行候选中按能力精确匹配，再结合用户给出的质量、速度、成本、分辨率、音色和格式要求选择。没有足够信息时选择最直接且可执行的一项，并报告选择依据。
3. `available: false`、`configuration-only`、缺凭据、停用或未接 adapter 的条目不可执行；它们只能作为诊断信息展示。
4. 不使用 `proma-generate-image`、`proma-gpt-image-2`、固定 GPT/Gemini/Nano Banana 名称或旧 Proma Cloud 凭据。模型名称必须来自本次目录读取。
5. 用户要求低成本或快速生成时仍先看真实能力和设置，不因 Skill 被触发就自动购买、切换供应商或扩大生成数量。

## 统一执行链

对带统一 `ref` 的可执行模型严格使用以下顺序：

```text
media_list_models / media_list_api_models
→ media_prepare_generation
→ media_execute_generation
→ media_wait_generation 或 media_get_generation
→ media_list_assets
```

取消当前任务时使用 `media_cancel_generation`，并传入明确的 `cancelIntent: "explicit"`。准备成功只表示参数和配置通过，不表示供应商已经收到请求；必须等待并报告真实终态、`runId`、模型引用、能力和输出资产。

执行前遵守当前媒体自主策略和付费审批。等待超时只代表当前状态未知或仍在运行，继续使用原 `runId` 查询，不重复提交同一付费任务。失败、取消、运行中和成功必须分开报告。

## 输入和资产安全

- 参考图片、音频和视频只使用 `media_list_assets` 或 Host 提供的已授权资产引用。
- 不把任意本地路径、凭据、远端 URL、供应商文件名或旧 Skill 示例直接塞进统一媒体工具。
- 需要引用已有媒体时，先获取可信 `assetRef`，再按模型能力传入；类型不匹配时先说明缺口。
- 语音任务报告模型支持的音色、格式和长度限制；歌曲任务报告模型真实支持的音乐类型和限制。
- 生成成功后交付受管媒体资产或明确资产引用，不能凭文件名猜测输出媒体类型。

## 与 canvas-production 的交接

只要任务包含多个有关联的媒体产物、分镜、套图、连续修改、画布节点、公共工作流、候选版本、内容验收或采用，就转交 `canvas-production`，由它负责画布上下文、节点关系、版本、审查和采用合同。本 Skill 只负责一次独立生成以及当前模型目录的能力发现。
