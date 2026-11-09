import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflow } from "../src/workflow.mjs";

const names = ["dramaclaw_get_creation_progress", "dramaclaw_start_ingest", "dramaclaw_build_characters",
  "dramaclaw_plan_episodes", "dramaclaw_plan_identities", "dramaclaw_generate_script",
  "dramaclaw_assign_sketch_colors", "dramaclaw_generate_sketches", "dramaclaw_detect_sketch_identities",
  "dramaclaw_render_first_frames", "read_other"];
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
  data.episode.identity_detected = 2; expect("first_frames_required", "dramaclaw_render_first_frames");
  data.episode.first_frames_present = 2; observe(workflow, data);
  assert.equal(workflow.plan().plan.reason, "review_first_frames");
  data.episode.sketches_stale = 1; observe(workflow, data);
  assert.equal(workflow.plan().tools.includes("dramaclaw_render_first_frames"), false);
  data.active_steps = ["sketches"]; observe(workflow, data);
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
