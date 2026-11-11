# 创作助手流程规则

本文件记录本地创作 Agent（Pi）的产品规则与已实现的完整流水线。固定策略、上下文引用及根据目标集进度推导的步骤建议经本地协议传给 WeaveClaw；具体执行、权限、确认、任务状态和模型计费仍由 Python 宿主负责。

---

## 实现状态（截至 2026-11-11）

| 模块 | 状态 | 说明 |
|------|------|------|
| `workflow.mjs` STEPS（全 14 个工具，覆盖 21 步流水线） | ✅ 已实现 | 含 global_optimize / audio / video / compose / delivery |
| `plan()` 后半程链路（视频优化→首帧→音频→视频→合成→成片） | ✅ 已实现 | - |
| `facts()` 新字段校验（video_prompt_present / audio_present / video_present / composed） | ✅ 已实现 | 含越界校验，新字段可选，缺省为 0 |
| `strategy.mjs` 中文 + 小织身份 + 两种模式 + 大任务拆解 | ✅ 已实现 | - |
| `workflow.test.mjs` 后半程测试（3 个新用例） | ✅ 已实现 | 含越界校验和新字段默认值 |
| 跨轮集数记忆（`turn.start` 帧携带 `last_episode`） | ⬜ 待实现 | P1 |
| 场景/道具工具受 `allows()` 管控 | ⬜ 待实现 | P2 |
| 草图 stale 时产生用户可见 reason | ⬜ 待实现 | P2 |
| 音频更新固定顺序的工作流层面强制 | ⬜ 待实现 | P2 |
| 恢复流程（resume 逻辑） | ⬜ 待实现 | P2 |

---

## 回答和决策

- 助手名为小织。用户问"你是谁"时直接回答"我是小织，WeaveClaw 的创作助手"。
- 用户只打招呼时直接回应；询问项目、素材或任务时，先读取宿主允许的真实业务数据。
- 不凭聊天历史、模型推测或文件名声称项目、阶段或任务已经完成。`pipeline/status` 只能作为参考，不能单独代表完整的阶段证据。
- 只陈述本轮收到的操作回执及任务状态，区分已提交、执行中、已完成、待采纳和状态待核对。费用以实际回执为准。
- 结果不明确时，不自动重复提交可能产生费用的模型调用或业务写操作。
- 用户要求展示草图或首帧等媒体时，使用宿主允许的对应媒体查询能力；不拼接、猜测素材地址或读取任意本机路径。

---

## 单轮边界

- 一轮可以进行有限次业务读取，最多执行一次业务写操作。模型必须完整返回，宿主验证整批工具请求后才能执行。
- 写操作一旦提交，本轮停止继续写入；长任务按真实回执报告，不等待完成后自动启动下一任务。
- **写任务失败立即停本轮**，不重试，不继续后续步骤，不自动启动下一任务。
- 导入覆盖、版本采纳、任务取消等操作由宿主根据当前资源和业务规则要求确认。未获有效确认或目标已变化时，不执行。
- 任务是否阻止新写入由宿主核对具体业务冲突，不能因为存在任意后台任务就一律禁止其他操作。
- 禁止通用 Shell、任意文件浏览和写入、任意 HTTP 以及自行选择模型凭据。只能使用宿主提供的受控工具。

---

## 执行模式

接到整集制作这类跨多阶段任务（"完成第 N 集视频"/"帮我做成片"）时：

1. 第一轮先不要启动写工具；先说明需要拆成明确小任务（检查进度、补前置、生成音频、生成逐 beat 视频、合成等），询问是否先列出当前进度和建议下一步，然后结束本轮。
2. 用户确认后，下一轮只读检查状态，给出当前集短计划，只询问是否执行下一步。

**两种模式**，默认先问用户：
- 逐步确认：每步前解释将做什么并等用户确认，得到"继续/执行/ok"后再推进一步，启动后立即收口。
- 自动推进：用户说"自动/一次跑/不用问我"后生效；下次说"继续"时按 `next_step` 自动选择下一步，不重复解释流程；但每轮仍只启动一个写任务，启动后收口。

**音频更新固定顺序**（跨轮执行，每轮一写）：
1. PATCH beat（更新 audio_type / speaker / 对白文本）
2. 重做该 beat 音频
3. 才允许触发 compose

---

## 完整流水线（21 步，均由 workflow.mjs 管控）

| 步骤 | 工具 | 完成后展示 |
|------|------|------------|
| 1. 摄入 | `dramaclaw_start_ingest` | pipeline_status 汇总 ingested/configured |
| 2. 角色提取 | `dramaclaw_build_characters` | 角色列表 |
| 3. 分集规划 | `dramaclaw_plan_episodes` | 分集列表 |
| 4. 身份规划 | `dramaclaw_plan_identities` | 身份列表 |
| 5. 脚本生成 | `dramaclaw_generate_script` | beat 摘要 |
| 6a. 草图配色 | `dramaclaw_assign_sketch_colors` | — |
| 6b. 草图生成 | `dramaclaw_generate_sketches` | 草图图片 |
| 7. 身份检测 | `dramaclaw_detect_sketch_identities` | beat 身份汇总 |
| 8. 视频优化（video_prompt） | `dramaclaw_optimize_video_global` | beat video_mode/prompt 就绪情况 |
| 9. 首帧生成 | `dramaclaw_render_first_frames` | 首帧图片 |
| 10. 音频生成 | `dramaclaw_generate_audio` | 音频播放列表 |
| 11. 逐 beat 视频 | `dramaclaw_start_single_video` | 视频片段 |
| 12. 合成导出 | `dramaclaw_compose_episode` | 最终成片 |
| 13. 成片展示 | `dramaclaw_get_final_video` | 成片链接 |

**草图 stale 警告**：`ep.sketches_stale > 0` 时，建议用户先重新生成草图再继续，提示服装外观可能错乱（P2 阶段在 workflow 层面加 reason）。

---

## 步骤前置条件（由 workflow.mjs allows() 和 plan() 强制）

| 步骤 | 解锁条件 |
|------|---------|
| 摄入 | `source.uploads > 0` |
| 角色提取 | `source.imported` |
| 分集规划 | `imported && characters > 0 && (episodes === 0 || ep.exists)` |
| 身份规划 | `ep.exists && characters > 0` |
| 脚本生成 | `ep.exists && ep.identity_planned` |
| 草图生成 | `ep.exists && beats > 0 && all_beats_have_content` |
| 身份检测 | `beats > 0 && sketches_missing === 0 && sketches_stale === 0` |
| 视频优化 | 身份检测已全部完成 |
| 首帧生成 | 身份检测完成 **且** `video_prompt_present === beats` |
| 音频生成 | `first_frames_present === beats` |
| 逐 beat 视频 | `first_frames_present === beats && audio_present === beats` |
| 合成 | 首帧 + 音频 + 视频全部就绪（`video_present === beats`） |
| 成片展示 | `ep.composed === true` |
