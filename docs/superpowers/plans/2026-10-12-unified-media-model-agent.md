# 统一媒体模型目录与 Agent 调用实施计划

## 目标

让图片、音频、视频模型共享一个公开模型引用与能力目录，普通 Agent 会话能够列出、准备、执行、等待和取消一次媒体生成；配置页继续保存供应商凭据，Agent 消息只携带稳定模型引用和非敏感参数。现有 `media_prepare_run` / `media_execute_run` 工作流工具继续兼容。

## 设计

1. 在 `packages/shared` 增加 `MediaModelRef`、媒体生成请求/结果/状态类型与严格解析函数。模型引用固定为 `media:<kind>:<provider>:<profileId>:<modelId>`，执行输入只允许文本、数字、布尔值和已授权素材引用。
2. 在主进程增加统一媒体目录投影：合并独立图片目录和独立音频目录，图片目录中的视频模型按统一引用暴露；ComfyUI 工作流和即梦 CLI 仍保留原入口，未接入统一 HTTP 执行器的候选明确标记不可用。凭据继续由各自 Store 按需解析。
3. 增加统一 HTTP 执行器 Facade：图片覆盖 OpenAI Images 与 MiniMax Image，音频覆盖小米 TTS 与 MiniMax Speech，视频覆盖 MiniMax Video；MiniMax Music 暂不接入，因为现有独立音频配置没有音乐协议合同。异步任务统一为 `prepare -> execute -> wait -> cancel`，远端轮询和响应解析不把上游正文泄露给 Agent。
4. 给 Agent 增加 `media_list_models`、`media_prepare_generation`、`media_execute_generation`、`media_wait_generation`、`media_cancel_generation` 工具，复用现有权限、预算、会话归属和显式执行审批。旧工具保持原语义。
5. Canvas 目录读取改用统一目录投影；未接入的适配器明确显示为不可执行，避免用户选择后才失败。已有 ComfyUI 工作流和图片任务不迁移、不改写。

## 测试与验证

- 先添加 Shared 解析、模型目录合并和适配器合同的失败测试，确认失败后再实现。
- 覆盖：模型引用格式、能力/媒体类型不匹配、停用模型、无凭据、重复模型、异步轮询、取消、越权和旧工具兼容。
- 运行相关 `bun test`，随后运行 `bun run typecheck`；检查 `git diff` 只包含本任务文件和必要测试，保留现有编排工厂改动。全量媒体测试中的 ComfyUI HTTP 测试需要本地监听权限，受限沙箱下可能以 `EPERM` 失败。

## 影响评估

- 对用户：模型只需配置一次，Agent、Canvas 和设置页看到同一模型身份；音频/视频从“仅配置/工作流”变成可被 Agent 明确调用的任务。
- 对关联模块：旧 ComfyUI workflow、旧 `media_*_run` 工具和图片作业 journal 保持兼容；新增 Facade 只在新工具和统一目录入口生效。
- 性能：目录读取按一次调用快照并按 profile 按需解密；轮询只保留单个任务 timer，不常驻连接；模型列表不携带媒体字节。取消视频只停止本地等待，远端取消需后续单独接入。
