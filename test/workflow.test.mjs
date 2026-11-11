import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflow } from "../src/workflow.mjs";

const names = ["weaveclaw_get_creation_progress", "weaveclaw_start_ingest", "weaveclaw_build_characters",
  "weaveclaw_plan_episodes", "weaveclaw_plan_identities", "weaveclaw_generate_script",
  "weaveclaw_assign_sketch_colors", "weaveclaw_generate_sketches", "weaveclaw_detect_sketch_identities",
  "weaveclaw_optimize_video_global", "weaveclaw_render_first_frames", "weaveclaw_generate_audio",
  "weaveclaw_start_single_video", "weaveclaw_compose_episode", "weaveclaw_get_final_video", "read_other"];
const initial = () => ({ version: 1, source: { uploads: 0, imported: false }, project: { characters: 0, episodes: 0, configured: true },
  episode: { number: 1, exists: false, identity_planned: false, beats: 0, all_beats_have_content: false,
    sketches_missing: 0, sketches_stale: 0, identity_detected: 0, first_frames_present: 0,
    video_prompt_present: 0, audio_present: 0, video_present: 0, composed: false }, active_steps: [] });
// Existing workflow cases model explicitly current artifacts; separate cases below exercise stale and unknown facts.
const freshFixture = (data) => {
  const ep = { ...data.episode };
  if (ep.audio_current === undefined && ep.audio_present !== undefined) {
    Object.assign(ep, { audio_current: ep.audio_ready ?? ep.audio_present, audio_stale: 0, audio_unknown: 0 });
  }
  if (ep.video_current === undefined && ep.video_present !== undefined) {
    Object.assign(ep, { video_current: ep.video_present, video_stale: 0, video_unknown: 0 });
  }
  if (ep.composed_freshness === undefined && ep.composed !== undefined) {
    ep.composed_freshness = ep.composed ? "current" : "missing";
  }
  return { ...data, episode: ep };
};
const observe = (workflow, data) => workflow.observe("weaveclaw_get_creation_progress", { episode: 1 },
  { ok: true, final: false, result: { ok: true, data: freshFixture(data) } });

test("parallel_tools 只包含当前可用的独立读取，不包含写入或依赖读取", () => {
  const safe = ["weaveclaw_list_characters", "weaveclaw_list_episodes"];
  const plan = createWorkflow([...names, ...safe, "weaveclaw_get_config_recommendation_context"]).plan();
  assert.deepEqual(plan.parallel_tools, safe);
  assert.ok(plan.parallel_tools.every((name) => plan.tools.includes(name)));
});

function qualityProgress() {
  const data = initial();
  data.source.imported = true;
  Object.assign(data.project, { characters: 1, episodes: 1 });
  Object.assign(data.episode, {
    exists: true, identity_planned: true, beats: 2, all_beats_have_content: true,
    identity_detected: 2, video_prompt_present: 2, first_frames_present: 2,
  });
  return data;
}

test("自动批次必须先验证当前首帧，不能靠现有成片跳过", () => {
  const workflow = createWorkflow([...names, "weaveclaw_verify_first_frames"], null,
    {start: 1, end: 1, current: 1, allow_write: true, quality_required: true});
  const data = qualityProgress();
  Object.assign(data.episode, {audio_present: 2, video_present: 2, composed: true});
  observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "quality_verify_required");
  assert.equal(workflow.plan().plan.next_tool, "weaveclaw_verify_first_frames");
  assert.equal(workflow.plan().batch.current, 1);
  data.episode.first_frames_quality = true;
  observe(workflow, data);
  assert.equal(workflow.plan().batch.current, 2);
});

test("动态跳过已完成的连续步骤，并在进度失效时清空", () => {
  const workflow = createWorkflow(names), data = initial();
  data.source.imported = true;
  Object.assign(data.project, { characters: 1, episodes: 1 });
  Object.assign(data.episode, { exists: true, identity_planned: true });
  observe(workflow, data);
  assert.deepEqual(workflow.plan().skipped, ["ingest", "characters", "episodes", "identity_plan"]);
  assert.equal(workflow.plan().plan.reason, "script_required");
  data.episode.identity_planned = false;
  observe(workflow, data);
  assert.deepEqual(workflow.plan().skipped, ["ingest", "characters", "episodes"]);
  workflow.observe("weaveclaw_get_creation_progress", { episode: 1 }, { ok: false, final: false, result: {} });
  assert.deepEqual(workflow.plan().skipped, []);
});

test("首帧质量不达标且未重试时建议重渲，重复规划不消耗宿主次数", () => {
  const workflow = createWorkflow(names), data = qualityProgress();
  Object.assign(data.episode, { first_frames_quality: false, retry_count: 0 });
  observe(workflow, data);
  const proposal = workflow.plan();
  assert.deepEqual(proposal.plan, {
    episode: 1, next_tool: "weaveclaw_render_first_frames", reason: "quality_retry", checkpoint: true,
  });
  assert.ok(proposal.tools.includes(proposal.plan.next_tool));
  assert.deepEqual(workflow.plan(), proposal);
  data.episode.retry_count = 1;
  assert.deepEqual(workflow.plan(), proposal);
  observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "quality_failed");
});

test("首帧重试耗尽后暂停音频和视频流水线", () => {
  for (const retry_count of [1, 2]) {
    const workflow = createWorkflow(names), data = qualityProgress();
    Object.assign(data.episode, { first_frames_quality: false, retry_count });
    for (const audio_present of [0, 1, 2]) {
      data.episode.audio_present = audio_present;
      observe(workflow, data);
      assert.deepEqual(workflow.plan().plan, { episode: 1, next_tool: null, reason: "quality_failed", checkpoint: true });
      assert.ok(!workflow.plan().tools.includes("weaveclaw_generate_audio"));
      assert.ok(!workflow.plan().tools.includes("weaveclaw_start_single_video"));
    }
  }
});

test("首帧质量达标或字段缺失时保持原有可选检查点", () => {
  for (const fields of [{}, { first_frames_quality: true, retry_count: 0 }, { first_frames_quality: true, retry_count: 1 }]) {
    const workflow = createWorkflow(names), data = qualityProgress();
    Object.assign(data.episode, fields);
    observe(workflow, data);
    assert.deepEqual(workflow.plan().plan, {
      episode: 1, next_tool: null, reason: "review_first_frames", checkpoint: true,
    });
    data.episode.audio_present = 1;
    observe(workflow, data);
    assert.equal(workflow.plan().plan.reason, "audio_required");
  }
});

test("质量重试不覆盖执行中或缺失首帧的前置建议", () => {
  const workflow = createWorkflow(names), data = qualityProgress();
  data.episode.first_frames_quality = false;
  data.episode.retry_count = 0;
  observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "quality_retry");
  data.active_steps = ["first_frames"];
  observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "await_task");
  data.active_steps = [];
  data.episode.first_frames_present = 1;
  observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "first_frames_required");
});

test("首帧质量与重试次数非法值使事实失效", () => {
  for (const [field, values] of [
    ["first_frames_quality", [null, 0, "false", {}]],
    ["retry_count", [null, -1, 0.5, "1", Number.MAX_SAFE_INTEGER + 1]],
  ]) {
    for (const value of values) {
      const workflow = createWorkflow(names), data = qualityProgress();
      data.episode[field] = value;
      observe(workflow, data);
      assert.equal(workflow.plan().plan, null);
      assert.deepEqual(workflow.plan().tools, [names[0], "read_other"]);
    }
  }
});

test("质量或重试次数未知时不建议质量重做", () => {
  for (const fields of [{ first_frames_quality: false }, { retry_count: 0 }]) {
    const workflow = createWorkflow(names), data = qualityProgress();
    Object.assign(data.episode, fields);
    observe(workflow, data);
    assert.notEqual(workflow.plan().plan.reason, "quality_retry");
  }
});

function batchProgress(workflow, number, completed = false) {
  const data = initial();
  data.source.imported = true;
  Object.assign(data.project, { characters: 1, episodes: 5 });
  Object.assign(data.episode, { number, exists: true, identity_planned: true });
  if (completed) Object.assign(data.episode, {
    beats: 1, all_beats_have_content: true, identity_detected: 1,
    video_prompt_present: 1, first_frames_present: 1, audio_present: 1,
    video_present: 1, composed: true,
  });
  workflow.observe(names[0], { episode: number }, { ok: true, final: false, result: { ok: true, data: freshFixture(data) } });
  return data;
}

test("批量范围从 start 开始，忽略 last_episode 且不修改调用方范围", () => {
  const batch = { start: 2, end: 5 }, workflow = createWorkflow(names, 4, batch);
  batch.start = 4;
  const proposal = workflow.plan();
  assert.deepEqual(proposal.batch, { start: 2, end: 5, current: 2 });
  assert.deepEqual(proposal.batch_episodes, [2, 3, 4, 5]);
  assert.deepEqual(proposal.plan, { episode: 2, next_tool: names[0], reason: "progress_required" });
  proposal.batch.current = 5;
  batchProgress(workflow, 2);
  assert.equal(workflow.plan().batch.current, 2);
  assert.equal(workflow.plan().plan.reason, "script_required");
  assert.deepEqual(workflow.plan(), workflow.plan());
});

test("当前集完成后只推进一集，重新读事实前不解锁写工具", () => {
  const workflow = createWorkflow(names, null, { start: 1, end: 3 });
  batchProgress(workflow, 1, true);
  const proposal = workflow.plan();
  assert.deepEqual(proposal.batch, { start: 1, end: 3, current: 2 });
  assert.deepEqual(proposal.plan, { episode: 2, next_tool: names[0], reason: "progress_required" });
  assert.deepEqual(proposal.tools, [names[0], "read_other"]);
  assert.equal(workflow.allows("weaveclaw_generate_script", { episode: 2 }), false);
  // Late duplicate and out-of-order replies cannot advance or replace current facts.
  batchProgress(workflow, 1, true);
  batchProgress(workflow, 3, true);
  assert.deepEqual(workflow.plan(), proposal);
  batchProgress(workflow, 2);
  assert.equal(workflow.plan().plan.episode, 2);
  assert.equal(workflow.plan().plan.reason, "script_required");
});

test("全部集完成后 current 超出 end 且返回末集 delivery，重复规划保持稳定", () => {
  for (const end of [1, 3]) {
    const workflow = createWorkflow(names, null, { start: 1, end });
    for (let episode = 1; episode <= end; episode++) batchProgress(workflow, episode, true);
    const proposal = workflow.plan();
    assert.deepEqual(proposal.batch, { start: 1, end, current: end + 1 });
    assert.deepEqual(proposal.plan, { episode: end, next_tool: "weaveclaw_get_final_video", reason: "delivery" });
    assert.equal(proposal.progress.percent, 100);
    assert.deepEqual(workflow.plan(), proposal);
    batchProgress(workflow, end, true);
    assert.deepEqual(workflow.plan(), proposal);
  }
});

test("批量规划不凭写回执、失败、执行中或前置缺失推进", () => {
  const workflow = createWorkflow(names, null, { start: 1, end: 2 });
  const data = batchProgress(workflow, 1, true);
  // Use a new workflow to check that composed alone is insufficient.
  const pending = createWorkflow(names, null, { start: 1, end: 2 });
  const refresh = () => pending.observe(names[0], { episode: 1 }, { ok: true, final: false, result: { ok: true, data: freshFixture(data) } });
  data.active_steps = ["compose"]; refresh();
  assert.equal(pending.plan().batch.current, 1);
  assert.equal(pending.plan().plan.reason, "await_task");
  data.active_steps = []; data.episode.sketches_stale = 1; refresh();
  assert.equal(pending.plan().batch.current, 1);
  pending.observe("weaveclaw_compose_episode", { episode: 1 }, { ok: true });
  assert.equal(pending.plan().batch.current, 1);
  pending.observe(names[0], { episode: 1 }, { ok: false });
  assert.equal(pending.plan().batch.current, 1);
  assert.equal(pending.plan().plan.reason, "progress_required");
});

test("批量参数拒绝非法边界，缺省时保持既有输出契约", () => {
  for (const batch of [{}, { start: 0, end: 2 }, { start: 3, end: 2 },
    { start: 1, end: 10001 }, { start: 1.5, end: 2 }, { start: "1", end: 2 }, { start: 1, end: 21 },
    { start: 1, end: 2, current: 3 }, { start: 1, end: 2, allow_write: 1 }]) {
    assert.throws(() => createWorkflow(names, null, batch), /invalid_batch/);
  }
  assert.equal(Object.hasOwn(createWorkflow(names).plan(), "batch"), false);
  assert.equal(Object.hasOwn(createWorkflow(names, null, null).plan(), "batch"), false);
  assert.deepEqual(createWorkflow([], null, { start: 1, end: 2 }).plan().batch,
    { start: 1, end: 2, current: 1 });
});

test("批次从宿主冻结的当前集恢复，不允许读取其他集", () => {
  const workflow = createWorkflow(names, 1, { start: 1, end: 3, current: 2, allow_write: true });
  assert.equal(workflow.plan().batch.current, 2);
  assert.deepEqual(workflow.plan().batch_episodes, [1, 2, 3]);
  assert.equal(workflow.allows(names[0], { episode: 1 }), false);
  assert.equal(workflow.allows(names[0], { episode: 2 }), true);
});

test("批量读取发现导入失败或仍在运行时不能推进", () => {
  for (const status of ["running", "failed", "cancelled"]) {
    const workflow = createWorkflow(names, null, { start: 1, end: 2 });
    const data = initial();
    data.source.imported = true; data.source.ingest = status;
    Object.assign(data.project, { characters: 1, episodes: 2 });
    Object.assign(data.episode, { exists: true, identity_planned: true, beats: 1, all_beats_have_content: true,
      sketches_missing: 0, sketches_stale: 0, identity_detected: 1, video_prompt_present: 1,
      first_frames_present: 1, audio_present: 1, video_present: 1, composed: true });
    observe(workflow, data);
    assert.equal(workflow.plan().batch.current, 1);
  }
});

test("多个工具前置满足时同时暴露，未满足的下游工具仍隐藏", () => {
  const workflow = createWorkflow(names), data = initial();
  data.source.imported = true;
  data.project.characters = 1;
  observe(workflow, data);
  assert.deepEqual(workflow.plan().tools, [
    "weaveclaw_get_creation_progress", "weaveclaw_build_characters",
    "weaveclaw_plan_episodes", "read_other",
  ]);
});

test("并行暴露时 next_tool 推荐首个未完成步骤而非工具列表首项", () => {
  for (const toolNames of [names, [...names].reverse()]) {
    const workflow = createWorkflow(toolNames), data = initial();
    data.source.imported = true;
    data.project.characters = 1;
    observe(workflow, data);
    const proposal = workflow.plan();
    assert.ok(proposal.tools.includes("weaveclaw_build_characters"));
    assert.ok(proposal.tools.includes("weaveclaw_plan_episodes"));
    assert.deepEqual(proposal.plan, {
      episode: 1, next_tool: "weaveclaw_plan_episodes", reason: "episodes_required",
    });

    // Script and sketch coloring are both unfinished and eligible. Reversing
    // registration must not recommend coloring ahead of the incomplete script.
    data.project.episodes = 1;
    Object.assign(data.episode, {
      exists: true, identity_planned: true, beats: 2,
      all_beats_have_content: false, sketches_missing: 2,
    });
    observe(workflow, data);
    const parallel = workflow.plan();
    assert.ok(parallel.tools.includes("weaveclaw_generate_script"));
    assert.ok(parallel.tools.includes("weaveclaw_assign_sketch_colors"));
    assert.deepEqual(parallel.plan, {
      episode: 1, next_tool: "weaveclaw_generate_script", reason: "script_required",
    });
  }
});

test("只有一个流水线工具满足前置时仅暴露该写工具，读取工具不受影响", () => {
  const workflow = createWorkflow(names), data = initial();
  data.source.uploads = 1;
  observe(workflow, data);
  const proposal = workflow.plan();
  assert.deepEqual(proposal.tools, [
    "weaveclaw_get_creation_progress", "weaveclaw_start_ingest", "read_other",
  ]);
  assert.equal(proposal.plan.next_tool, "weaveclaw_start_ingest");
});

test("摄入完成且配置明确未设置时给出非阻断推荐", () => {
  const workflow = createWorkflow(names), data = initial();
  data.source.imported = true;
  data.source.ingest = "completed";
  data.project.characters = 2;
  data.project.configured = false;
  observe(workflow, data);
  const proposal = workflow.plan();
  assert.deepEqual(proposal.plan, {
    episode: 1, next_tool: null, reason: "config_recommendation", checkpoint: true,
  });
  assert.deepEqual(workflow.plan(), proposal);
  assert.deepEqual(proposal.progress, { step: 2, total: 14, percent: 14 });
  assert.ok(proposal.tools.includes("weaveclaw_build_characters"));
  assert.ok(proposal.tools.includes("weaveclaw_plan_episodes"));
  assert.equal(workflow.allows("weaveclaw_plan_episodes", { episode: 1 }), true);
  // Awaiting a task takes priority over optional recommendations.
  data.active_steps = ["episodes"];
  observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "await_task");
});

test("推荐必须先读取同一项目的原文与版本，刷新或失败后不沿用", () => {
  const context = "weaveclaw_get_config_recommendation_context", proposal = "weaveclaw_propose_config_recommendation";
  const workflow = createWorkflow([...names, context, proposal, "weaveclaw_update_project"]), data = initial();
  assert.ok(!workflow.plan().tools.includes(context));
  data.source.imported = true;
  data.source.ingest = "completed";
  data.project.configured = false;
  observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "config_recommendation");
  assert.ok(workflow.plan().tools.includes(context));
  assert.ok(!workflow.plan().tools.includes(proposal));
  const state = { source_sha256: "a".repeat(64), expected_revision: "b".repeat(32) };
  workflow.observe(context, { episode: 1 }, { ok: true, final: false, result: { ok: true, data: state } });
  assert.ok(workflow.allows(proposal, { episode: 1, ...state }));
  assert.equal(workflow.allows(proposal, { episode: 1, ...state, expected_revision: "c".repeat(32) }), false);
  assert.equal(workflow.allows("weaveclaw_update_project", { visual_style: "anime" }), false);
  const values = { visual_style: "anime", narration_style: "third_person", ethnicity: "Chinese", rhythm: "medium" };
  workflow.observe(proposal, { episode: 1 }, { ok: true, final: false, result: { ok: true, data: { ...state, recommendations: values } } });
  assert.deepEqual(workflow.plan().recommendations, values);
  observe(workflow, data);
  assert.equal(workflow.plan().recommendations, undefined);
  assert.ok(!workflow.plan().tools.includes(proposal));
});

test("缺少配置事实时不推断未配置", () => {
  const workflow = createWorkflow(names), data = initial();
  data.source.imported = true;
  data.project.characters = 1;
  delete data.project.configured;
  observe(workflow, data);
  assert.deepEqual(workflow.plan().plan, {
    episode: 1, next_tool: "weaveclaw_plan_episodes", reason: "episodes_required",
  });
});

test("配置已设置时恢复正常流水线，配置改变仅在刷新后生效", () => {
  const workflow = createWorkflow(names), data = initial();
  data.source.imported = true;
  data.source.ingest = "completed";
  data.project.characters = 1;
  data.project.configured = false;
  observe(workflow, data);
  data.project.configured = true;
  assert.equal(workflow.plan().plan.reason, "config_recommendation");
  observe(workflow, data);
  assert.deepEqual(workflow.plan().plan, {
    episode: 1, next_tool: "weaveclaw_plan_episodes", reason: "episodes_required",
  });
});

test("摄入未完成时不提前推荐配置", () => {
  const workflow = createWorkflow(names), data = initial();
  data.project.configured = false;
  data.source.uploads = 1;
  observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "ingest_required");
  data.source.imported = true;
  for (const status of ["not_observed", "running", "failed", "cancelled"]) {
    data.source.ingest = status;
    observe(workflow, data);
    assert.notEqual(workflow.plan().plan.reason, "config_recommendation");
    assert.equal(workflow.plan().tools.includes("weaveclaw_get_config_recommendation_context"), false);
  }
  data.source.ingest = "completed";
  observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "config_recommendation");
});

test("configured 非布尔值使进度失效而非误判已配置", () => {
  for (const configured of [null, 0, 1, "true", "false", {}]) {
    const workflow = createWorkflow(names), data = initial();
    data.source.imported = true;
    data.project.characters = 1;
    data.project.configured = configured;
    observe(workflow, data);
    assert.equal(workflow.plan().plan, null);
    assert.deepEqual(workflow.plan().tools, [names[0], "read_other"]);
  }
});

test("progress 按最新事实计算已完成工具数与四舍五入百分比", () => {
  const workflow = createWorkflow(names), data = initial();
  const expect = (step, percent) => {
    observe(workflow, data);
    assert.deepEqual(workflow.plan().progress, { step, total: 14, percent });
  };
  expect(0, 0);
  data.source.uploads = 1; expect(0, 0);
  data.source.imported = true; expect(1, 7);
  data.project.characters = 1; expect(2, 14);
  data.project.episodes = 1; data.episode.exists = true; expect(3, 21);
  data.episode.identity_planned = true; expect(4, 29);
  Object.assign(data.episode, { beats: 2, all_beats_have_content: true, sketches_missing: 1 });
  expect(5, 36);
  data.episode.sketches_missing = 0; expect(7, 50);
  data.episode.identity_detected = 2; expect(8, 57);
  data.episode.video_prompt_present = 2; expect(9, 64);
  data.episode.first_frames_present = 2; expect(10, 71);
  assert.equal(workflow.plan().plan.reason, "review_first_frames");
  assert.deepEqual(workflow.plan().progress, { step: 10, total: 14, percent: 71 });
  data.episode.audio_present = 1; expect(10, 71);
  assert.equal(workflow.plan().plan.reason, "audio_required");
  data.episode.audio_present = 2; expect(11, 79);
  data.episode.video_present = 2; expect(12, 86);
  data.episode.composed = true; expect(14, 100);
  assert.equal(workflow.plan().plan.reason, "delivery");
  // Reading an already composed delivery does not undo completion, whereas
  // a compose rerun is still an unfinished write even with an old artifact.
  data.active_steps = ["delivery"]; expect(14, 100);
  assert.equal(workflow.plan().plan.reason, "await_task");
  data.active_steps = ["compose"]; expect(12, 86);
  data.active_steps = [];
  // A newly missing prerequisite must invalidate downstream completion.
  data.episode.sketches_stale = 1; expect(5, 36);
});

test("执行中不计为完成，刷新失败清空进度，重连从事实恢复", () => {
  const data = initial(), workflow = createWorkflow(names, 1);
  Object.assign(data, { source: { uploads: 1, imported: true }, project: { characters: 1, episodes: 1, configured: true } });
  Object.assign(data.episode, { exists: true, identity_planned: true, beats: 2, all_beats_have_content: true, sketches_missing: 2 });
  data.active_steps = ["script"];
  observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "await_task");
  assert.deepEqual(workflow.plan().progress, { step: 4, total: 14, percent: 29 });
  data.active_steps = [];
  observe(workflow, data);
  assert.deepEqual(workflow.plan().progress, { step: 5, total: 14, percent: 36 });
  const resumed = createWorkflow(names, 1);
  observe(resumed, data);
  assert.deepEqual(resumed.plan().progress, workflow.plan().progress);
  workflow.observe(names[0], { episode: 1 }, { ok: false, final: false });
  assert.deepEqual(workflow.plan().progress, { step: 0, total: 14, percent: 0 });
});

test("未读取事实及下一工具不可用时仍包含 progress", () => {
  for (const last_episode of [null, 1]) {
    assert.deepEqual(createWorkflow(names, last_episode).plan().progress, { step: 0, total: 14, percent: 0 });
  }
  const workflow = createWorkflow([names[0]]), data = initial();
  data.source.imported = true;
  observe(workflow, data);
  assert.equal(workflow.plan().plan, null);
  assert.deepEqual(workflow.plan().progress, { step: 1, total: 14, percent: 7 });
});

test("三个 sketches 工具仅在目标集进度中存在角色时允许执行", () => {
  const workflow = createWorkflow(names), data = initial();
  const sketches = ["weaveclaw_assign_sketch_colors", "weaveclaw_generate_sketches", "weaveclaw_detect_sketch_identities"];
  for (const name of sketches) assert.equal(workflow.allows(name, { episode: 1 }), false);
  for (const characters of [0, 1, 2, 0]) {
    data.project.characters = characters;
    observe(workflow, data);
    for (const name of sketches) {
      assert.equal(workflow.allows(name, { episode: 1 }), characters > 0, `${name}: characters=${characters}`);
      assert.equal(workflow.allows(name, {}), characters > 0);
      assert.equal(workflow.allows(name, { episode: 2 }), false);
    }
    // 此次仅增加角色前置；不扩展为 plan() 的全部阶段门槛。
    assert.equal(workflow.allows("weaveclaw_generate_script", { episode: 1 }), true);
  }
});

test("跳过音频时 allows 拒绝合成和逐 beat 视频", () => {
  const workflow = createWorkflow(names), data = initial();
  for (const audio_present of [undefined, 0]) {
    if (audio_present === undefined) delete data.episode.audio_present;
    else data.episode.audio_present = audio_present;
    observe(workflow, data);
    assert.equal(workflow.allows("weaveclaw_compose_episode", { episode: 1 }), false);
    assert.equal(workflow.allows("weaveclaw_start_single_video", { episode: 1 }), false);
  }
});

test("音频全部就绪后 allows 才允许目标集的视频和合成", () => {
  const workflow = createWorkflow(names), data = initial();
  data.episode.beats = 2;
  observe(workflow, data);
  assert.equal(workflow.allows("weaveclaw_compose_episode", { episode: 1 }), false);
  data.episode.audio_present = 1;
  observe(workflow, data);
  for (const name of ["weaveclaw_compose_episode", "weaveclaw_start_single_video"]) {
    assert.equal(workflow.allows(name, { episode: 1 }), false);
    assert.equal(workflow.allows(name, { episode: 2 }), false);
  }
  data.episode.audio_present = 2;
  observe(workflow, data);
  assert.equal(workflow.allows("weaveclaw_start_single_video", { episode: 1 }), true);
  assert.equal(workflow.allows("weaveclaw_compose_episode", { episode: 1 }), false);
  data.episode.video_present = 2;
  observe(workflow, data);
  assert.equal(workflow.allows("weaveclaw_compose_episode", { episode: 1 }), true);
  data.episode.audio_present = 0;
  observe(workflow, data);
  assert.equal(workflow.allows("weaveclaw_compose_episode", { episode: 1 }), false);
});

test("resumed episode only suggests reading progress and fresh target facts take precedence", () => {
  assert.equal(createWorkflow(names, null).plan().plan, null);
  const workflow = createWorkflow(names, 7);
  const fallback = { tools: [names[0], "read_other"], plan: {
    episode: 7, next_tool: names[0], reason: "progress_required",
  }, progress: { step: 0, total: 14, percent: 0 }, skipped: [], parallel_tools: [] };
  assert.deepEqual(workflow.plan(), fallback);
  assert.equal(workflow.allows("weaveclaw_generate_script", { episode: 7 }), false);
  const data = initial();
  data.episode.number = 8;
  workflow.observe(names[0], { episode: 8 }, { ok: true, final: false, result: { ok: true, data: freshFixture(data) } });
  assert.equal(workflow.plan().plan.episode, 8);
  workflow.observe(names[0], { episode: 8 }, { ok: false, final: false, result: { ok: false } });
  assert.deepEqual(workflow.plan(), fallback);
  assert.equal(createWorkflow(["read_other"], 7).plan().plan, null);
});

test("场景和道具规划仅在目标集的 beat 内容就绪且脚本未运行时可用", () => {
  const planners = ["weaveclaw_plan_scenes", "weaveclaw_plan_props"];
  const workflow = createWorkflow([...names, ...planners], 1);
  const data = initial();
  const update = (value = { ok: true, final: false, result: { ok: true, data: freshFixture(data) } }) =>
    workflow.observe(names[0], { episode: 1 }, value);
  const expectAvailable = (expected) => {
    for (const tool of planners) {
      assert.equal(workflow.plan().tools.includes(tool), expected);
      assert.equal(workflow.allows(tool, { episode: 1 }), expected);
      assert.equal(workflow.allows(tool, { episode: 2 }), false);
    }
  };
  expectAvailable(false);
  data.episode.exists = true;
  update(); expectAvailable(false);
  data.episode.beats = 2;
  update(); expectAvailable(false);
  data.episode.all_beats_have_content = true;
  update(); expectAvailable(true);
  assert.equal(workflow.plan().progress.total, 14);
  data.active_steps = ["script"];
  update(); expectAvailable(false);
  data.active_steps = [];
  update(); expectAvailable(true);
  update({ ok: false, final: false, result: { ok: false } }); expectAvailable(false);
  update(); expectAvailable(true);
  data.episode.exists = false;
  update(); expectAvailable(false);
});

test("场景和道具规划不会复用其他项目或其他集数的进度", () => {
  const planners = ["weaveclaw_plan_scenes", "weaveclaw_plan_props"];
  const data = initial();
  Object.assign(data.episode, { exists: true, beats: 1, all_beats_have_content: true });
  const reply = { ok: true, final: false, result: { ok: true, data: freshFixture(data) } };
  const home = createWorkflow([...names, ...planners], null, null, "home");
  home.observe(names[0], { episode: 1, project_id: "project-a" }, reply);
  for (const tool of planners) {
    assert.equal(home.allows(tool, { episode: 1, project_id: "project-a" }), true);
    assert.equal(home.allows(tool, { episode: 1, project_id: "project-b" }), false);
    assert.equal(home.allows(tool, { episode: 1 }), false);
    assert.equal(home.allows(tool, { episode: 2, project_id: "project-a" }), false);
  }
  home.observe(names[0], { episode: 1 }, reply);
  for (const tool of planners) assert.equal(home.plan().tools.includes(tool), false);
  const project = createWorkflow([...names, ...planners], null, null, "project");
  project.observe(names[0], { episode: 1 }, reply);
  for (const tool of planners) assert.equal(project.allows(tool, { episode: 1 }), true);
});

test("重连读取目标集后从首个未完成步骤续接，不依赖本轮完成历史", () => {
  const data = initial();
  data.episode.number = 7;
  data.episode.exists = true;
  const cases = [
    [() => { data.source = { uploads: 1, imported: true }; }, "weaveclaw_build_characters"],
    [() => { data.project.characters = 2; }, "weaveclaw_plan_episodes"],
    [() => { data.project.episodes = 7; data.episode.exists = true; }, "weaveclaw_plan_identities"],
    [() => { data.episode.identity_planned = true; }, "weaveclaw_generate_script"],
    [() => { Object.assign(data.episode, { beats: 3, all_beats_have_content: true, sketches_missing: 2 }); }, "weaveclaw_generate_sketches"],
    [() => { data.episode.sketches_missing = 0; data.episode.identity_detected = 1; }, "weaveclaw_detect_sketch_identities"],
    [() => { data.episode.identity_detected = 3; data.episode.video_prompt_present = 1; }, "weaveclaw_optimize_video_global"],
    [() => { data.episode.video_prompt_present = 3; data.episode.first_frames_present = 1; }, "weaveclaw_render_first_frames"],
    [() => { data.episode.first_frames_present = 3; data.episode.audio_present = 1; }, "weaveclaw_generate_audio"],
    [() => { data.episode.audio_present = 3; data.episode.video_present = 1; }, "weaveclaw_start_single_video"],
    [() => { data.episode.video_present = 3; }, "weaveclaw_compose_episode"],
    [() => { data.episode.composed = true; }, "weaveclaw_get_final_video"],
  ];
  for (const [complete, next_tool] of cases) {
    complete();
    // Each case simulates a new connection with no in-memory workflow history.
    const workflow = createWorkflow(names, 7);
    assert.deepEqual(workflow.plan().plan, {
      episode: 7, next_tool: "weaveclaw_get_creation_progress", reason: "progress_required",
    });
    workflow.observe(names[0], { episode: 7 }, { ok: true, final: false, result: { ok: true, data: freshFixture(data) } });
    const proposal = workflow.plan();
    assert.equal(proposal.plan.episode, 7);
    assert.equal(proposal.plan.next_tool, next_tool);
    assert.ok(proposal.tools.includes(next_tool));
    assert.deepEqual(workflow.plan(), proposal);
    if (data.episode.composed) assert.equal(proposal.plan.reason, "delivery");
  }
});

test("记忆中的集数已删除时停止续接并请求用户选择", () => {
  const data = initial();
  data.episode.number = 7;
  data.episode.exists = false;
  const workflow = createWorkflow(names, 7);
  workflow.observe(names[0], { episode: 7 }, { ok: true, final: false, result: { ok: true, data: freshFixture(data) } });
  assert.deepEqual(workflow.plan().plan, { episode: 7, next_tool: null, reason: "episode_missing", checkpoint: true });
  assert.equal(workflow.allows("weaveclaw_generate_script", { episode: 7 }), false);
});

test("手动完成当前步骤后刷新进度，plan 跳过该步骤", () => {
  const workflow = createWorkflow(names), data = initial();
  data.source.uploads = 1;
  observe(workflow, data);
  assert.equal(workflow.plan().plan.next_tool, "weaveclaw_start_ingest");

  // Completion is reported only by fresh facts, without observing a write receipt.
  data.source.imported = true;
  observe(workflow, data);
  assert.deepEqual(workflow.plan().plan, {
    episode: 1, next_tool: "weaveclaw_build_characters", reason: "characters_required",
  });
});

test("同一会话中多个步骤由用户完成，plan 直接跳到首个未完成步骤", () => {
  const workflow = createWorkflow(names), data = initial();
  data.source.imported = true;
  observe(workflow, data);
  assert.equal(workflow.plan().plan.next_tool, "weaveclaw_build_characters");

  Object.assign(data.project, { characters: 2, episodes: 1 });
  Object.assign(data.episode, {
    exists: true, identity_planned: true, beats: 3, all_beats_have_content: true,
    sketches_missing: 0, identity_detected: 3, video_prompt_present: 3,
    first_frames_present: 3, audio_present: 3, video_present: 1,
  });
  // Mutating an external response cannot advance the plan before a fresh read.
  assert.equal(workflow.plan().plan.next_tool, "weaveclaw_build_characters");
  observe(workflow, data);
  const proposal = workflow.plan();
  assert.deepEqual(proposal.plan, {
    episode: 1, next_tool: "weaveclaw_start_single_video", reason: "video_required",
  });
  assert.ok(proposal.tools.includes(proposal.plan.next_tool));

  // Later completed stages must not hide a newly incomplete prerequisite.
  data.episode.video_prompt_present = 2;
  observe(workflow, data);
  assert.equal(workflow.plan().plan.next_tool, "weaveclaw_optimize_video_global");
});

test("刷新发现所有步骤均已完成时 plan 返回 delivery", () => {
  const workflow = createWorkflow(names), data = initial();
  data.source.uploads = 1;
  observe(workflow, data);
  assert.equal(workflow.plan().plan.next_tool, "weaveclaw_start_ingest");

  data.source.imported = true;
  Object.assign(data.project, { characters: 2, episodes: 1 });
  Object.assign(data.episode, {
    exists: true, identity_planned: true, beats: 3, all_beats_have_content: true,
    sketches_missing: 0, identity_detected: 3, video_prompt_present: 3,
    first_frames_present: 3, audio_present: 3, video_present: 3, composed: true,
  });
  observe(workflow, data);
  const proposal = workflow.plan();
  assert.deepEqual(proposal.plan, {
    episode: 1, next_tool: "weaveclaw_get_final_video", reason: "delivery",
  });
  assert.ok(proposal.tools.includes(proposal.plan.next_tool));
  assert.deepEqual(workflow.plan(), proposal);
});

test("恢复时已有任务只等待，进度刷新失败则重新读取而不沿用旧断点", () => {
  const workflow = createWorkflow(names, 1), data = initial();
  Object.assign(data, { source: { uploads: 1, imported: true }, project: { characters: 2, episodes: 1, configured: true } });
  Object.assign(data.episode, { exists: true, identity_planned: true });
  data.active_steps = ["script"];
  observe(workflow, data);
  assert.deepEqual(workflow.plan().plan, { episode: 1, next_tool: null, reason: "await_task" });
  data.active_steps = [];
  observe(workflow, data);
  assert.equal(workflow.plan().plan.next_tool, "weaveclaw_generate_script");
  workflow.observe(names[0], { episode: 1 }, { ok: false, final: false, result: { ok: false } });
  assert.deepEqual(workflow.plan(), {
    tools: [names[0], "read_other"],
    plan: { episode: 1, next_tool: names[0], reason: "progress_required" },
    progress: { step: 0, total: 14, percent: 0 }, skipped: [], parallel_tools: [],
  });
});

test("workflow hides pipeline writes until it receives valid target progress", () => {
  const workflow = createWorkflow(names);
  assert.deepEqual(workflow.plan(), { tools: [names[0], "read_other"], plan: null, progress: { step: 0, total: 14, percent: 0 }, skipped: [], parallel_tools: [] });
  const data = initial();
  data.episode.number = 2;
  observe(workflow, data);
  assert.equal(workflow.plan().plan, null);
  data.episode.number = 1;
  observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "source_missing");
  assert.equal(workflow.plan().tools.includes("weaveclaw_start_ingest"), false);
  assert.equal(workflow.allows("weaveclaw_generate_script", { episode: 2 }), false);
  assert.equal(workflow.allows("weaveclaw_generate_script", { episode: 1 }), true);
});

test("workflow suggests stages and exposes writes only after prerequisites", () => {
  const workflow = createWorkflow(names), data = initial();
  const expect = (reason, tool) => {
    observe(workflow, data);
    const proposal = workflow.plan();
    assert.equal(proposal.plan.reason, reason);
    assert.equal(proposal.plan.next_tool, tool);
    assert.ok(proposal.tools.includes(tool));
    assert.deepEqual(workflow.plan(), proposal);
  };
  data.source.uploads = 1; expect("ingest_required", "weaveclaw_start_ingest");
  data.source.imported = true; expect("characters_required", "weaveclaw_build_characters");
  data.project.characters = 1; expect("episodes_required", "weaveclaw_plan_episodes");
  data.project.episodes = 1; data.episode.exists = true; expect("identity_plan_required", "weaveclaw_plan_identities");
  data.episode.identity_planned = true; expect("script_required", "weaveclaw_generate_script");
  Object.assign(data.episode, { beats: 2, all_beats_have_content: true, sketches_missing: 2 });
  expect("sketches_required", "weaveclaw_generate_sketches");
  data.episode.sketches_missing = 0; expect("identity_detection_required", "weaveclaw_detect_sketch_identities");
  data.episode.identity_detected = 2; expect("global_optimize_required", "weaveclaw_optimize_video_global");
  data.episode.video_prompt_present = 2; expect("first_frames_required", "weaveclaw_render_first_frames");
  data.episode.first_frames_present = 2;
  // 首帧就绪、音频未开始：到达 review_first_frames 可选检查点（不阻断，音频工具保持解锁）
  observe(workflow, data);
  assert.deepEqual(workflow.plan().plan, { episode: 1, next_tool: null, reason: "review_first_frames", checkpoint: true });
  assert.ok(workflow.plan().tools.includes("weaveclaw_generate_audio"));
  data.episode.audio_present = 1; expect("audio_required", "weaveclaw_generate_audio");
  data.episode.audio_present = 2; expect("video_required", "weaveclaw_start_single_video");
  data.episode.video_present = 2; expect("compose_required", "weaveclaw_compose_episode");
  data.episode.composed = true; observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "delivery");
  assert.ok(workflow.plan().tools.includes("weaveclaw_get_final_video"));
  // stale sketches gate still blocks render_first_frames even when downstream is complete
  data.episode.sketches_stale = 1; observe(workflow, data);
  assert.equal(workflow.plan().tools.includes("weaveclaw_render_first_frames"), false);
  assert.equal(workflow.plan().tools.includes("weaveclaw_optimize_video_global"), false);
  data.episode.sketches_stale = 0; data.active_steps = ["sketches"]; observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "await_task");
  assert.equal(workflow.plan().tools.includes("weaveclaw_generate_sketches"), false);
});

test("草图旧批次产生可选警告且不新增工具阻断，新批次恢复正常建议", () => {
  const workflow = createWorkflow(names), data = initial();
  Object.assign(data, { source: { uploads: 1, imported: true }, project: { characters: 1, episodes: 1, configured: true } });
  Object.assign(data.episode, {
    exists: true, identity_planned: true, beats: 2, all_beats_have_content: true,
    sketches_stale: 1, identity_detected: 2, video_prompt_present: 2,
    first_frames_present: 2, audio_present: 2,
  });
  observe(workflow, data);
  const proposal = workflow.plan();
  assert.deepEqual(proposal.plan, { episode: 1, next_tool: null, reason: "sketches_stale", checkpoint: true });
  assert.deepEqual(workflow.plan(), proposal);
  for (const name of ["weaveclaw_generate_sketches", "weaveclaw_generate_audio", "weaveclaw_start_single_video"]) {
    assert.ok(proposal.tools.includes(name));
    assert.equal(workflow.allows(name, { episode: 1 }), true);
  }
  // Existing stale gates remain unchanged, as do active-task priorities.
  assert.equal(proposal.tools.includes("weaveclaw_render_first_frames"), false);
  data.active_steps = ["sketches"]; observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "await_task");
  data.active_steps = []; data.episode.sketches_stale = 0; observe(workflow, data);
  assert.deepEqual(workflow.plan().plan, { episode: 1, next_tool: "weaveclaw_start_single_video", reason: "video_required" });
  assert.ok(workflow.plan().tools.includes("weaveclaw_render_first_frames"));
  data.episode.sketches_missing = 1; observe(workflow, data);
  assert.deepEqual(workflow.plan().plan, { episode: 1, next_tool: "weaveclaw_generate_sketches", reason: "sketches_required" });
});

test("invalid or failed progress cannot unlock writes or inject plan text", () => {
  const workflow = createWorkflow(names), data = initial();
  data.source.imported = "yes";
  observe(workflow, data);
  assert.deepEqual(workflow.plan(), { tools: [names[0], "read_other"], plan: null, progress: { step: 0, total: 14, percent: 0 }, skipped: [], parallel_tools: [] });
  data.source.imported = true; data.project.characters = 1;
  data.episode.private = "do not echo";
  observe(workflow, data);
  assert.equal(JSON.stringify(workflow.plan()).includes("do not echo"), false);
  workflow.observe("weaveclaw_get_creation_progress", { episode: 1 }, { ok: false, final: false, result: { ok: false } });
  // A failed refresh must not continue on stale facts.
  assert.deepEqual(workflow.plan(), { tools: [names[0], "read_other"], plan: null, progress: { step: 0, total: 14, percent: 0 }, skipped: [], parallel_tools: [] });
});

test("a missing target episode in an existing plan does not trigger replanning", () => {
  const workflow = createWorkflow(names), data = initial();
  data.source.imported = true;
  data.project.characters = 2;
  data.project.episodes = 3;
  observe(workflow, data);
  assert.equal(workflow.plan().plan, null);
  assert.equal(workflow.plan().tools.includes("weaveclaw_plan_episodes"), false);
});

test("second-half pipeline gates audio, video and compose behind prior stages", () => {
  const workflow = createWorkflow(names), data = initial();
  // Set up a fully-ready-for-audio episode (through global_optimize + first_frames).
  Object.assign(data, {
    source: { uploads: 1, imported: true },
    project: { characters: 2, episodes: 1, configured: true },
  });
  Object.assign(data.episode, {
    exists: true, identity_planned: true, beats: 3, all_beats_have_content: true,
    sketches_missing: 0, sketches_stale: 0, identity_detected: 3,
    video_prompt_present: 3, first_frames_present: 3,
  });
  observe(workflow, data);
  // 首帧就绪、音频未开始：先到达 review_first_frames 可选检查点，但音频工具不被阻断。
  assert.equal(workflow.plan().plan.reason, "review_first_frames");
  assert.equal(workflow.plan().plan.next_tool, null);
  assert.equal(workflow.plan().plan.checkpoint, true);
  assert.ok(workflow.plan().tools.includes("weaveclaw_generate_audio"));
  // Video tool is still hidden (audio not done).
  assert.equal(workflow.plan().tools.includes("weaveclaw_start_single_video"), false);
  // Compose and final_video are hidden too.
  assert.equal(workflow.plan().tools.includes("weaveclaw_compose_episode"), false);
  assert.equal(workflow.plan().tools.includes("weaveclaw_get_final_video"), false);

  // 音频开始后（跳过审查）链路自动进入 audio_required。
  data.episode.audio_present = 1; observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "audio_required");
  assert.equal(workflow.plan().plan.next_tool, "weaveclaw_generate_audio");

  data.episode.audio_present = 3; observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "video_required");
  assert.ok(workflow.plan().tools.includes("weaveclaw_start_single_video"));
  assert.equal(workflow.plan().tools.includes("weaveclaw_compose_episode"), false);

  data.episode.video_present = 3; observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "compose_required");
  assert.ok(workflow.plan().tools.includes("weaveclaw_compose_episode"));
  assert.equal(workflow.plan().tools.includes("weaveclaw_get_final_video"), false);

  data.episode.composed = true; observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "delivery");
  assert.ok(workflow.plan().tools.includes("weaveclaw_get_final_video"));
});

test("missing post-production facts do not invent a next step", () => {
  const workflow = createWorkflow(names), data = initial();
  Object.assign(data, { source: { uploads: 1, imported: true }, project: { characters: 1, episodes: 1, configured: true } });
  Object.assign(data.episode, { exists: true, identity_planned: true, beats: 2, all_beats_have_content: true, identity_detected: 2 });
  delete data.episode.video_prompt_present;
  observe(workflow, data);
  assert.equal(workflow.plan().plan, null);
  assert.equal(workflow.plan().tools.includes("weaveclaw_render_first_frames"), false);
});

test("out-of-range new fields in progress response are rejected", () => {
  const workflow = createWorkflow(names), data = initial();
  Object.assign(data.episode, { beats: 2, video_prompt_present: 5 }); // 5 > beats=2
  observe(workflow, data);
  // Invalid data must not unlock anything.
  assert.deepEqual(workflow.plan(), { tools: [names[0], "read_other"], plan: null, progress: { step: 0, total: 14, percent: 0 }, skipped: [], parallel_tools: [] });
  data.episode.video_prompt_present = -1;
  observe(workflow, data);
  assert.deepEqual(workflow.plan(), { tools: [names[0], "read_other"], plan: null, progress: { step: 0, total: 14, percent: 0 }, skipped: [], parallel_tools: [] });
});

test("review_first_frames 可选检查点在首帧就绪后出现且不阻断流水线", () => {
  const workflow = createWorkflow([...names, "weaveclaw_review_first_frames"]), data = initial();
  // 未登记进 STEPS 的工具（如审查读工具）不受流水线门控，授权由宿主负责
  assert.equal(workflow.allows("weaveclaw_review_first_frames", {}), true);
  Object.assign(data, { source: { uploads: 1, imported: true }, project: { characters: 1, episodes: 1, configured: true } });
  Object.assign(data.episode, {
    exists: true, identity_planned: true, beats: 2, all_beats_have_content: true,
    sketches_missing: 0, sketches_stale: 0, identity_detected: 2,
    video_prompt_present: 2, first_frames_present: 2, audio_present: 0,
  });
  observe(workflow, data);
  // 触发：首帧全部就绪、音频未开始时标记可选检查点（next_tool 为空）
  const proposal = workflow.plan();
  assert.deepEqual(proposal.plan, { episode: 1, next_tool: null, reason: "review_first_frames", checkpoint: true });
  assert.deepEqual(workflow.plan(), proposal);
  // 不阻断：音频生成与首帧重渲保持解锁，审查工具照常可用
  assert.ok(proposal.tools.includes("weaveclaw_generate_audio"));
  assert.ok(proposal.tools.includes("weaveclaw_render_first_frames"));
  assert.equal(workflow.allows("weaveclaw_review_first_frames", { episode: 1 }), true);
  assert.equal(workflow.allows("weaveclaw_generate_audio", { episode: 1 }), true);
  // 下游写工具仍被挡住
  assert.equal(proposal.tools.includes("weaveclaw_start_single_video"), false);
  assert.equal(proposal.tools.includes("weaveclaw_compose_episode"), false);
});

test("跳过首帧审查后链路自动进入 audio_required", () => {
  const workflow = createWorkflow(names), data = initial();
  Object.assign(data, { source: { uploads: 1, imported: true }, project: { characters: 1, episodes: 1, configured: true } });
  Object.assign(data.episode, {
    exists: true, identity_planned: true, beats: 2, all_beats_have_content: true,
    sketches_missing: 0, sketches_stale: 0, identity_detected: 2,
    video_prompt_present: 2, first_frames_present: 2, audio_present: 0,
  });
  observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "review_first_frames");
  // 跳过审查（或自动推进）后音频开始：链路自动进入 audio_required，且不再是检查点
  data.episode.audio_present = 1; observe(workflow, data);
  assert.deepEqual(workflow.plan().plan, { episode: 1, next_tool: "weaveclaw_generate_audio", reason: "audio_required" });
  assert.ok(workflow.plan().tools.includes("weaveclaw_generate_audio"));
});

test("后半程 reason 节点按链路顺序依次出现", () => {
  const workflow = createWorkflow(names), data = initial();
  Object.assign(data, { source: { uploads: 1, imported: true }, project: { characters: 1, episodes: 1, configured: true } });
  Object.assign(data.episode, {
    exists: true, identity_planned: true, beats: 2, all_beats_have_content: true,
    sketches_missing: 0, sketches_stale: 0, identity_detected: 2,
  });
  const expect = (reason, tool) => {
    observe(workflow, data);
    const proposal = workflow.plan();
    assert.equal(proposal.plan.reason, reason);
    assert.equal(proposal.plan.next_tool, tool);
    assert.ok(proposal.tools.includes(tool));
  };
  expect("global_optimize_required", "weaveclaw_optimize_video_global");
  data.episode.video_prompt_present = 2; expect("first_frames_required", "weaveclaw_render_first_frames");
  data.episode.first_frames_present = 2;
  observe(workflow, data);
  assert.deepEqual(workflow.plan().plan, { episode: 1, next_tool: null, reason: "review_first_frames", checkpoint: true });
  data.episode.audio_present = 1; expect("audio_required", "weaveclaw_generate_audio");
  data.episode.audio_present = 2; expect("video_required", "weaveclaw_start_single_video");
  data.episode.video_present = 2; expect("compose_required", "weaveclaw_compose_episode");
  data.episode.composed = true; expect("delivery", "weaveclaw_get_final_video");
});

test("缺失下游事实不会推断完成或缺失", () => {
  const workflow = createWorkflow(names), data = qualityProgress();
  data.episode.audio_present = 2; data.episode.video_present = 2;
  for (const field of ["video_prompt_present", "audio_present", "video_present", "composed"]) {
    const saved = data.episode[field];
    delete data.episode[field];
    observe(workflow, data);
    assert.ok(workflow.plan().plan === null || workflow.plan().plan.reason.endsWith("_unknown"), field);
    data.episode[field] = saved;
  }
});

test("过期或未知素材不能解锁视频、合成或交付", () => {
  const workflow = createWorkflow(names), data = qualityProgress();
  Object.assign(data.episode, { audio_present: 2, video_present: 2, composed: true });
  for (const [field, values, reason, blocked] of [
    ["audio", { audio_current: 1, audio_stale: 1, audio_unknown: 0 }, "audio_stale", "weaveclaw_start_single_video"],
    ["audio", { audio_current: 1, audio_stale: 0, audio_unknown: 1 }, "audio_unknown", "weaveclaw_compose_episode"],
    ["video", { video_current: 1, video_stale: 1, video_unknown: 0 }, "video_stale", "weaveclaw_compose_episode"],
    ["video", { video_current: 1, video_stale: 0, video_unknown: 1 }, "video_unknown", "weaveclaw_compose_episode"],
    ["composition", { composed_freshness: "stale" }, "composition_stale", "weaveclaw_get_final_video"],
    ["composition", { composed_freshness: "unknown" }, "composition_unknown", "weaveclaw_get_final_video"],
  ]) {
    const probe = freshFixture(data);
    Object.assign(probe.episode, values);
    workflow.observe(names[0], { episode: 1 }, { ok: true, final: false, result: { ok: true, data: probe } });
    assert.deepEqual(workflow.plan().plan, { episode: 1, next_tool: null, reason, checkpoint: true }, field);
    assert.equal(workflow.plan().tools.includes(blocked), false, field);
    assert.equal(workflow.allows(blocked, { episode: 1 }), false, field);
  }
});

test("用户确认的未知素材可继续，但保持未知来源且拒绝无效确认数量", () => {
  const workflow = createWorkflow(names), data = qualityProgress();
  Object.assign(data.episode, {
    audio_present: 2, audio_current: 1, audio_stale: 0, audio_unknown: 1, audio_confirmed: 1,
    video_present: 2, video_current: 1, video_stale: 0, video_unknown: 1, video_confirmed: 1,
    composed: true, composed_freshness: "unknown", composition_confirmed: true,
  });
  observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "delivery");
  assert.equal(workflow.allows("weaveclaw_get_final_video", { episode: 1 }), true);
  assert.equal(data.episode.composed_freshness, "unknown");
  data.episode.audio_confirmed = 0;
  observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "audio_unknown");
  assert.equal(workflow.allows("weaveclaw_get_final_video", { episode: 1 }), false);
  data.episode.audio_confirmed = 2;
  observe(workflow, data);
  assert.equal(workflow.plan().plan, null);
});

test("静音镜头计入音频就绪但不伪造音频文件", () => {
  const workflow = createWorkflow(names), data = qualityProgress();
  Object.assign(data.episode, { audio_present: 1, audio_ready: 2 });
  observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "video_required");
  assert.equal(workflow.allows("weaveclaw_start_single_video", { episode: 1 }), true);
  data.episode.audio_ready = 0;
  observe(workflow, data);
  assert.equal(workflow.plan().plan, null);
});

test("新字段边界值 0 与等于 beats 均可通过校验", () => {
  const workflow = createWorkflow(names), data = initial();
  Object.assign(data, { source: { uploads: 1, imported: true }, project: { characters: 1, episodes: 1, configured: true } });
  Object.assign(data.episode, {
    exists: true, identity_planned: true, beats: 2, all_beats_have_content: true,
    sketches_missing: 0, sketches_stale: 0, identity_detected: 2,
    first_frames_present: 0, audio_present: 0, video_present: 0,
  });
  // video_prompt_present：0（下界）→ 视频优化未就绪；2=beats（上界）→ 进入首帧阶段
  data.episode.video_prompt_present = 0; observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "global_optimize_required");
  data.episode.video_prompt_present = 2; observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "first_frames_required");
  // audio_present：0（下界）→ 可选检查点；2=beats（上界）→ 进入视频阶段
  data.episode.first_frames_present = 2; observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "review_first_frames");
  data.episode.audio_present = 2; observe(workflow, data);
  // video_present：0（下界）→ 仍需逐 beat 视频
  assert.equal(workflow.plan().plan.reason, "video_required");
  // video_present：2=beats（上界）→ 进入合成阶段
  data.episode.video_present = 2; observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "compose_required");
});

test("新字段越界或非法值使目标集进度失效", () => {
  const workflow = createWorkflow(names);
  const hidden = { tools: [names[0], "read_other"], plan: null, progress: { step: 0, total: 14, percent: 0 }, skipped: [], parallel_tools: [] };
  const rejects = (field, value) => {
    const probe = initial();
    probe.episode.beats = 2;
    probe.episode[field] = value;
    observe(workflow, probe);
    assert.deepEqual(workflow.plan(), hidden, `${field}=${JSON.stringify(value)} 应被拒绝`);
  };
  for (const field of ["video_prompt_present", "audio_present", "video_present"]) {
    rejects(field, 3); // 越上界（大于 beats）
    rejects(field, -1); // 负数
    rejects(field, 1.5); // 非整数
    rejects(field, "2"); // 非数字
  }
  // composed 只接受布尔值
  const bad = initial();
  bad.episode.composed = "true"; observe(workflow, bad);
  assert.deepEqual(workflow.plan(), hidden);
  bad.episode.composed = 1; observe(workflow, bad);
  assert.deepEqual(workflow.plan(), hidden);
});

test("音频回退为未开始时可选检查点重现", () => {
  const workflow = createWorkflow(names), data = initial();
  Object.assign(data, { source: { uploads: 1, imported: true }, project: { characters: 1, episodes: 1, configured: true } });
  Object.assign(data.episode, {
    exists: true, identity_planned: true, beats: 2, all_beats_have_content: true,
    sketches_missing: 0, sketches_stale: 0, identity_detected: 2,
    video_prompt_present: 2, first_frames_present: 2,
  });
  data.episode.audio_present = 1; observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "audio_required");
  // 音频重做清空后（audio_present 回退为 0）检查点重现：语义为事实驱动、非一次性标记
  data.episode.audio_present = 0; observe(workflow, data);
  assert.deepEqual(workflow.plan().plan, { episode: 1, next_tool: null, reason: "review_first_frames", checkpoint: true });
});
