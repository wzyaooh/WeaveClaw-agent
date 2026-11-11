import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflow } from "../src/workflow.mjs";

const names = ["dramaclaw_get_creation_progress", "dramaclaw_start_ingest", "dramaclaw_build_characters",
  "dramaclaw_plan_episodes", "dramaclaw_plan_identities", "dramaclaw_generate_script",
  "dramaclaw_assign_sketch_colors", "dramaclaw_generate_sketches", "dramaclaw_detect_sketch_identities",
  "dramaclaw_optimize_video_global", "dramaclaw_render_first_frames", "dramaclaw_generate_audio",
  "dramaclaw_start_single_video", "dramaclaw_compose_episode", "dramaclaw_get_final_video", "read_other"];
const initial = () => ({ version: 1, source: { uploads: 0, imported: false }, project: { characters: 0, episodes: 0 },
  episode: { number: 1, exists: false, identity_planned: false, beats: 0, all_beats_have_content: false,
    sketches_missing: 0, sketches_stale: 0, identity_detected: 0, first_frames_present: 0 }, active_steps: [] });
const observe = (workflow, data) => workflow.observe("dramaclaw_get_creation_progress", { episode: 1 },
  { ok: true, final: false, result: { ok: true, data } });

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
  assert.equal(workflow.plan().tools.includes("dramaclaw_start_ingest"), false);
  assert.equal(workflow.allows("dramaclaw_generate_script", { episode: 2 }), false);
  assert.equal(workflow.allows("dramaclaw_generate_script", { episode: 1 }), true);
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
  data.source.uploads = 1; expect("ingest_required", "dramaclaw_start_ingest");
  data.source.imported = true; expect("characters_required", "dramaclaw_build_characters");
  data.project.characters = 1; expect("episodes_required", "dramaclaw_plan_episodes");
  data.project.episodes = 1; data.episode.exists = true; expect("identity_plan_required", "dramaclaw_plan_identities");
  data.episode.identity_planned = true; expect("script_required", "dramaclaw_generate_script");
  Object.assign(data.episode, { beats: 2, all_beats_have_content: true, sketches_missing: 2 });
  expect("sketches_required", "dramaclaw_generate_sketches");
  data.episode.sketches_missing = 0; expect("identity_detection_required", "dramaclaw_detect_sketch_identities");
  data.episode.identity_detected = 2; expect("global_optimize_required", "dramaclaw_optimize_video_global");
  data.episode.video_prompt_present = 2; expect("first_frames_required", "dramaclaw_render_first_frames");
  data.episode.first_frames_present = 2; expect("audio_required", "dramaclaw_generate_audio");
  data.episode.audio_present = 2; expect("video_required", "dramaclaw_start_single_video");
  data.episode.video_present = 2; expect("compose_required", "dramaclaw_compose_episode");
  data.episode.composed = true; observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "delivery");
  assert.ok(workflow.plan().tools.includes("dramaclaw_get_final_video"));
  // stale sketches gate still blocks render_first_frames even when downstream is complete
  data.episode.sketches_stale = 1; observe(workflow, data);
  assert.equal(workflow.plan().tools.includes("dramaclaw_render_first_frames"), false);
  assert.equal(workflow.plan().tools.includes("dramaclaw_optimize_video_global"), false);
  data.episode.sketches_stale = 0; data.active_steps = ["sketches"]; observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "await_task");
  assert.equal(workflow.plan().tools.includes("dramaclaw_generate_sketches"), false);
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
  workflow.observe("dramaclaw_get_creation_progress", { episode: 1 }, { ok: false, final: false, result: { ok: false } });
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
  assert.equal(workflow.plan().tools.includes("dramaclaw_plan_episodes"), false);
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
  // Audio should be the next suggested step.
  assert.equal(workflow.plan().plan.reason, "audio_required");
  assert.equal(workflow.plan().plan.next_tool, "dramaclaw_generate_audio");
  assert.ok(workflow.plan().tools.includes("dramaclaw_generate_audio"));
  // Video tool is still hidden (audio not done).
  assert.equal(workflow.plan().tools.includes("dramaclaw_start_single_video"), false);
  // Compose and final_video are hidden too.
  assert.equal(workflow.plan().tools.includes("dramaclaw_compose_episode"), false);
  assert.equal(workflow.plan().tools.includes("dramaclaw_get_final_video"), false);

  data.episode.audio_present = 3; observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "video_required");
  assert.ok(workflow.plan().tools.includes("dramaclaw_start_single_video"));
  assert.equal(workflow.plan().tools.includes("dramaclaw_compose_episode"), false);

  data.episode.video_present = 3; observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "compose_required");
  assert.ok(workflow.plan().tools.includes("dramaclaw_compose_episode"));
  assert.equal(workflow.plan().tools.includes("dramaclaw_get_final_video"), false);

  data.episode.composed = true; observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "delivery");
  assert.ok(workflow.plan().tools.includes("dramaclaw_get_final_video"));
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
  assert.ok(workflow.plan().tools.includes("dramaclaw_optimize_video_global"));
  // Audio and downstream tools remain hidden.
  assert.equal(workflow.plan().tools.includes("dramaclaw_generate_audio"), false);
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
