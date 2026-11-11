/** Local workflow suggestions; the host still owns authorization and effects. */
const STEPS = new Map([
  ["weaveclaw_start_ingest", "ingest"],
  ["weaveclaw_build_characters", "characters"],
  ["weaveclaw_plan_episodes", "episodes"],
  ["weaveclaw_plan_identities", "identity_plan"],
  ["weaveclaw_generate_script", "script"],
  ["weaveclaw_assign_sketch_colors", "sketches"],
  ["weaveclaw_generate_sketches", "sketches"],
  ["weaveclaw_detect_sketch_identities", "sketches"],
  ["weaveclaw_optimize_video_global", "global_optimize"],
  ["weaveclaw_render_first_frames", "first_frames"],
  ["weaveclaw_generate_audio", "audio"],
  ["weaveclaw_start_single_video", "video"],
  ["weaveclaw_compose_episode", "compose"],
  ["weaveclaw_get_final_video", "delivery"],
]);
const ACTIVE = new Set(STEPS.values());
const count = (x) => Number.isSafeInteger(x) && x >= 0;

function facts(result, episode) {
  const data = result?.ok === true && result?.data;
  const { source, project, episode: ep, active_steps: active } = data || {};
  if (!data || data.version !== 1 || !source || !project || !ep || ep.number !== episode || !Number.isSafeInteger(episode) || episode < 1 || episode > 10000 ||
      !count(source.uploads) || typeof source.imported !== "boolean" ||
      !count(project.characters) || !count(project.episodes) || typeof ep.exists !== "boolean" ||
      typeof ep.identity_planned !== "boolean" || !count(ep.beats) || typeof ep.all_beats_have_content !== "boolean" ||
      !count(ep.sketches_missing) || !count(ep.sketches_stale) || !count(ep.identity_detected) || !count(ep.first_frames_present) ||
      ep.sketches_missing > ep.beats || ep.sketches_stale > ep.beats || ep.identity_detected > ep.beats || ep.first_frames_present > ep.beats ||
      (ep.video_prompt_present !== undefined && (!count(ep.video_prompt_present) || ep.video_prompt_present > ep.beats)) ||
      (ep.audio_present !== undefined && (!count(ep.audio_present) || ep.audio_present > ep.beats)) ||
      (ep.video_present !== undefined && (!count(ep.video_present) || ep.video_present > ep.beats)) ||
      (ep.composed !== undefined && typeof ep.composed !== "boolean") ||
      !Array.isArray(active) || active.some((item) => !ACTIVE.has(item)) || new Set(active).size !== active.length) return null;
  return {
    source: { uploads: source.uploads, imported: source.imported },
    project: { characters: project.characters, episodes: project.episodes },
    ep: { number: ep.number, exists: ep.exists, identity_planned: ep.identity_planned, beats: ep.beats,
      all_beats_have_content: ep.all_beats_have_content, sketches_missing: ep.sketches_missing,
      sketches_stale: ep.sketches_stale, identity_detected: ep.identity_detected, first_frames_present: ep.first_frames_present,
      video_prompt_present: ep.video_prompt_present !== undefined ? ep.video_prompt_present : 0,
      audio_present: ep.audio_present !== undefined ? ep.audio_present : 0,
      video_present: ep.video_present !== undefined ? ep.video_present : 0,
      composed: ep.composed === true },
    active: new Set(active),
  };
}

export function createWorkflow(toolNames) {
  const available = [...toolNames];
  let progress = null;
  return {
    allows(name, args) {
      if (!STEPS.has(name)) return true;
      return Boolean(progress && (!Object.hasOwn(args, "episode") || args.episode === progress.ep.number));
    },
    observe(name, args, value) {
      if (name === "weaveclaw_get_creation_progress") {
        progress = value?.ok === true && value.final === false ? facts(value.result, args?.episode) : null;
      }
    },
    plan() {
      const allowed = new Set();
      let reason = null, next = null;
      if (progress) {
        const { source, project, ep, active } = progress;
        const permit = (name, condition) => { if (condition && !active.has(STEPS.get(name))) allowed.add(name); };
        permit("weaveclaw_start_ingest", source.uploads > 0);
        permit("weaveclaw_build_characters", source.imported);
        permit("weaveclaw_plan_episodes", source.imported && project.characters > 0 && (project.episodes === 0 || ep.exists));
        permit("weaveclaw_plan_identities", ep.exists && project.characters > 0);
        permit("weaveclaw_generate_script", ep.exists && ep.identity_planned);
        permit("weaveclaw_assign_sketch_colors", ep.exists && ep.beats > 0);
        permit("weaveclaw_generate_sketches", ep.exists && ep.beats > 0 && ep.all_beats_have_content);
        const sketchesReady = ep.beats > 0 && ep.sketches_missing === 0 && ep.sketches_stale === 0;
        const identitiesDetected = sketchesReady && ep.identity_detected === ep.beats;
        const videoPromptsReady = ep.beats > 0 && ep.video_prompt_present === ep.beats;
        const framesReady = ep.beats > 0 && ep.first_frames_present === ep.beats;
        const audioReady = ep.beats > 0 && ep.audio_present === ep.beats;
        const videoReady = ep.beats > 0 && ep.video_present === ep.beats;
        permit("weaveclaw_detect_sketch_identities", sketchesReady);
        permit("weaveclaw_optimize_video_global", identitiesDetected);
        permit("weaveclaw_render_first_frames", identitiesDetected && videoPromptsReady);
        permit("weaveclaw_generate_audio", framesReady);
        permit("weaveclaw_start_single_video", framesReady && audioReady);
        permit("weaveclaw_compose_episode", framesReady && audioReady && videoReady);
        permit("weaveclaw_get_final_video", ep.composed);
        if (active.size) reason = "await_task";
        else if (!source.imported && !source.uploads) reason = "source_missing";
        else if (!source.imported) [reason, next] = ["ingest_required", "weaveclaw_start_ingest"];
        else if (!project.characters) [reason, next] = ["characters_required", "weaveclaw_build_characters"];
        else if (!project.episodes) [reason, next] = ["episodes_required", "weaveclaw_plan_episodes"];
        else if (!ep.exists) reason = null;
        else if (!ep.identity_planned) [reason, next] = ["identity_plan_required", "weaveclaw_plan_identities"];
        else if (!ep.beats || !ep.all_beats_have_content) [reason, next] = ["script_required", "weaveclaw_generate_script"];
        else if (!sketchesReady) [reason, next] = ["sketches_required", "weaveclaw_generate_sketches"];
        else if (ep.identity_detected !== ep.beats) [reason, next] = ["identity_detection_required", "weaveclaw_detect_sketch_identities"];
        else if (!videoPromptsReady) [reason, next] = ["global_optimize_required", "weaveclaw_optimize_video_global"];
        else if (!framesReady) [reason, next] = ["first_frames_required", "weaveclaw_render_first_frames"];
        else if (!audioReady) [reason, next] = ["audio_required", "weaveclaw_generate_audio"];
        else if (!videoReady) [reason, next] = ["video_required", "weaveclaw_start_single_video"];
        else if (!ep.composed) [reason, next] = ["compose_required", "weaveclaw_compose_episode"];
        else [reason, next] = ["delivery", "weaveclaw_get_final_video"];
      }
      const tools = available.filter((name) => !STEPS.has(name) || allowed.has(name));
      if (next && !tools.includes(next)) return { tools, plan: null };
      return { tools, plan: reason ? { episode: progress.ep.number, next_tool: next, reason } : null };
    },
  };
}
