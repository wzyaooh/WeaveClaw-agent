import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflow } from "../src/workflow.mjs";

const names = ["weaveclaw_get_creation_progress", "weaveclaw_start_ingest", "weaveclaw_build_characters",
  "weaveclaw_plan_episodes", "weaveclaw_plan_identities", "weaveclaw_generate_script",
  "weaveclaw_assign_sketch_colors", "weaveclaw_generate_sketches", "weaveclaw_detect_sketch_identities",
  "weaveclaw_optimize_video_global", "weaveclaw_render_first_frames", "weaveclaw_generate_audio",
  "weaveclaw_start_single_video", "weaveclaw_compose_episode", "weaveclaw_get_final_video", "read_other"];
const initial = () => ({ version: 1, source: { uploads: 0, imported: false }, project: { characters: 0, episodes: 0 },
  episode: { number: 1, exists: false, identity_planned: false, beats: 0, all_beats_have_content: false,
    sketches_missing: 0, sketches_stale: 0, identity_detected: 0, first_frames_present: 0 }, active_steps: [] });
const observe = (workflow, data) => workflow.observe("weaveclaw_get_creation_progress", { episode: 1 },
  { ok: true, final: false, result: { ok: true, data } });

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

test("音频进度出现后 allows 允许目标集的视频和合成", () => {
  const workflow = createWorkflow(names), data = initial();
  data.episode.beats = 2;
  observe(workflow, data);
  assert.equal(workflow.allows("weaveclaw_compose_episode", { episode: 1 }), false);
  data.episode.audio_present = 1;
  observe(workflow, data);
  for (const name of ["weaveclaw_compose_episode", "weaveclaw_start_single_video"]) {
    assert.equal(workflow.allows(name, { episode: 1 }), true);
    assert.equal(workflow.allows(name, { episode: 2 }), false);
  }
  data.episode.audio_present = 2;
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
  } };
  assert.deepEqual(workflow.plan(), fallback);
  assert.equal(workflow.allows("weaveclaw_generate_script", { episode: 7 }), false);
  const data = initial();
  data.episode.number = 8;
  workflow.observe(names[0], { episode: 8 }, { ok: true, final: false, result: { ok: true, data } });
  assert.equal(workflow.plan().plan.episode, 8);
  workflow.observe(names[0], { episode: 8 }, { ok: false, final: false, result: { ok: false } });
  assert.deepEqual(workflow.plan(), fallback);
  assert.equal(createWorkflow(["read_other"], 7).plan().plan, null);
});

test("workflow hides pipeline writes until it receives valid target progress", () => {
  const workflow = createWorkflow(names);
  assert.deepEqual(workflow.plan(), { tools: [names[0], "read_other"], plan: null });
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
  Object.assign(data, { source: { uploads: 1, imported: true }, project: { characters: 1, episodes: 1 } });
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
  assert.deepEqual(workflow.plan(), { tools: [names[0], "read_other"], plan: null });
  data.source.imported = true; data.project.characters = 1;
  data.episode.private = "do not echo";
  observe(workflow, data);
  assert.equal(JSON.stringify(workflow.plan()).includes("do not echo"), false);
  workflow.observe("weaveclaw_get_creation_progress", { episode: 1 }, { ok: false, final: false, result: { ok: false } });
  // A failed refresh must not continue on stale facts.
  assert.deepEqual(workflow.plan(), { tools: [names[0], "read_other"], plan: null });
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
    project: { characters: 2, episodes: 1 },
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

test("new fields are optional and default to 0 when absent from progress response", () => {
  const workflow = createWorkflow(names), data = initial();
  Object.assign(data, {
    source: { uploads: 1, imported: true },
    project: { characters: 1, episodes: 1 },
  });
  Object.assign(data.episode, {
    exists: true, identity_planned: true, beats: 2, all_beats_have_content: true,
    sketches_missing: 0, sketches_stale: 0, identity_detected: 2, first_frames_present: 0,
    // video_prompt_present / audio_present / video_present / composed intentionally omitted
  });
  observe(workflow, data);
  // Without video_prompt_present, global_optimize is the next suggested step.
  assert.equal(workflow.plan().plan.reason, "global_optimize_required");
  assert.ok(workflow.plan().tools.includes("weaveclaw_optimize_video_global"));
  // Audio and downstream tools remain hidden.
  assert.equal(workflow.plan().tools.includes("weaveclaw_generate_audio"), false);
});

test("out-of-range new fields in progress response are rejected", () => {
  const workflow = createWorkflow(names), data = initial();
  Object.assign(data.episode, { beats: 2, video_prompt_present: 5 }); // 5 > beats=2
  observe(workflow, data);
  // Invalid data must not unlock anything.
  assert.deepEqual(workflow.plan(), { tools: [names[0], "read_other"], plan: null });
  data.episode.video_prompt_present = -1;
  observe(workflow, data);
  assert.deepEqual(workflow.plan(), { tools: [names[0], "read_other"], plan: null });
});

test("review_first_frames 可选检查点在首帧就绪后出现且不阻断流水线", () => {
  const workflow = createWorkflow([...names, "weaveclaw_review_first_frames"]), data = initial();
  // 未登记进 STEPS 的工具（如审查读工具）不受流水线门控，授权由宿主负责
  assert.equal(workflow.allows("weaveclaw_review_first_frames", {}), true);
  Object.assign(data, { source: { uploads: 1, imported: true }, project: { characters: 1, episodes: 1 } });
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
  Object.assign(data, { source: { uploads: 1, imported: true }, project: { characters: 1, episodes: 1 } });
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
  Object.assign(data, { source: { uploads: 1, imported: true }, project: { characters: 1, episodes: 1 } });
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

test("新字段缺省时默认为 0 或 false 并照常参与门槛计算", () => {
  const workflow = createWorkflow(names), data = initial();
  Object.assign(data, { source: { uploads: 1, imported: true }, project: { characters: 1, episodes: 1 } });
  Object.assign(data.episode, {
    exists: true, identity_planned: true, beats: 2, all_beats_have_content: true,
    sketches_missing: 0, sketches_stale: 0, identity_detected: 2,
  });
  // video_prompt_present 缺省 → 按 0 计算：视频优化未就绪
  observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "global_optimize_required");
  // audio_present 缺省 → 按 0 计算：首帧就绪后停在可选检查点
  data.episode.video_prompt_present = 2; data.episode.first_frames_present = 2;
  observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "review_first_frames");
  // video_present 缺省 → 按 0 计算：音频就绪后仍需逐 beat 视频
  data.episode.audio_present = 2;
  observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "video_required");
  // composed 缺省 → 按 false 计算：视频就绪后仍未进入 delivery
  data.episode.video_present = 2;
  observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "compose_required");
});

test("新字段边界值 0 与等于 beats 均可通过校验", () => {
  const workflow = createWorkflow(names), data = initial();
  Object.assign(data, { source: { uploads: 1, imported: true }, project: { characters: 1, episodes: 1 } });
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
  const hidden = { tools: [names[0], "read_other"], plan: null };
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
  Object.assign(data, { source: { uploads: 1, imported: true }, project: { characters: 1, episodes: 1 } });
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
