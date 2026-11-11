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

function completion(progress) {
  let step = 0;
  if (progress) {
    const { source, project, ep, active } = progress;
    const beatsReady = ep.beats > 0;
    const sketchesReady = beatsReady && ep.sketches_missing === 0 && ep.sketches_stale === 0;
    // Coloring has no separate completion fact; ready sketches certify both
    // coloring and generation. Never infer completion from a write receipt.
    const completed = [
      source.imported, project.characters > 0, project.episodes > 0 && ep.exists,
      ep.identity_planned, beatsReady && ep.all_beats_have_content,
      sketchesReady, sketchesReady, beatsReady && ep.identity_detected === ep.beats,
      beatsReady && ep.video_prompt_present === ep.beats,
      beatsReady && ep.first_frames_present === ep.beats,
      beatsReady && ep.audio_ready === ep.beats,
      beatsReady && ep.video_present === ep.beats, ep.composed, ep.composed,
    ];
    // Count the completed prefix, so stale downstream artifacts cannot hide a
    // missing prerequisite. Delivery is 100% once the final artifact is ready.
    for (const [index, stage] of [...STEPS.values()].entries()) {
      if (!completed[index] || (stage !== "delivery" && active.has(stage))) break;
      step++;
    }
  }
  return { step, total: STEPS.size, percent: Math.round(step / STEPS.size * 100) };
}

function facts(result, episode) {
  const data = result?.ok === true && result?.data;
  const { source, project, episode: ep, active_steps: active } = data || {};
  if (!data || data.version !== 1 || !source || !project || !ep || ep.number !== episode || !Number.isSafeInteger(episode) || episode < 1 || episode > 10000 ||
      !count(source.uploads) || typeof source.imported !== "boolean" ||
      !count(project.characters) || !count(project.episodes) ||
      (project.configured !== undefined && typeof project.configured !== "boolean") || typeof ep.exists !== "boolean" ||
      typeof ep.identity_planned !== "boolean" || !count(ep.beats) || typeof ep.all_beats_have_content !== "boolean" ||
      !count(ep.sketches_missing) || !count(ep.sketches_stale) || !count(ep.identity_detected) || !count(ep.first_frames_present) ||
      ep.sketches_missing > ep.beats || ep.sketches_stale > ep.beats || ep.identity_detected > ep.beats || ep.first_frames_present > ep.beats ||
      (ep.video_prompt_present !== undefined && (!count(ep.video_prompt_present) || ep.video_prompt_present > ep.beats)) ||
      (ep.audio_present !== undefined && (!count(ep.audio_present) || ep.audio_present > ep.beats)) ||
      (ep.audio_ready !== undefined && (!count(ep.audio_ready) || ep.audio_ready > ep.beats ||
        (ep.audio_present !== undefined && ep.audio_ready < ep.audio_present))) ||
      (ep.video_present !== undefined && (!count(ep.video_present) || ep.video_present > ep.beats)) ||
       (ep.composed !== undefined && typeof ep.composed !== "boolean") ||
       (ep.first_frames_quality !== undefined && typeof ep.first_frames_quality !== "boolean") ||
       (ep.retry_count !== undefined && !count(ep.retry_count)) ||
      !Array.isArray(active) || active.some((item) => !ACTIVE.has(item)) || new Set(active).size !== active.length) return null;
  return {
    source: { uploads: source.uploads, imported: source.imported },
    project: { characters: project.characters, episodes: project.episodes, configured: project.configured ?? null },
    ep: { number: ep.number, exists: ep.exists, identity_planned: ep.identity_planned, beats: ep.beats,
      all_beats_have_content: ep.all_beats_have_content, sketches_missing: ep.sketches_missing,
       sketches_stale: ep.sketches_stale, identity_detected: ep.identity_detected, first_frames_present: ep.first_frames_present,
      first_frames_quality: ep.first_frames_quality ?? null,
      retry_count: ep.retry_count ?? null,
      video_prompt_present: ep.video_prompt_present ?? null,
      audio_present: ep.audio_present ?? null,
      audio_ready: ep.audio_ready ?? ep.audio_present ?? null,
      video_present: ep.video_present ?? null,
      composed: ep.composed ?? null },
    active: new Set(active),
  };
}

export function createWorkflow(toolNames, last_episode = null, batch = null) {
  if (batch !== null && (!Number.isSafeInteger(batch.start) || !Number.isSafeInteger(batch.end) ||
      batch.start < 1 || batch.end > 10000 || batch.start > batch.end)) throw new RangeError("invalid_batch");
  // Copy caller-owned bounds; each episode requires its own fresh facts.
  const range = batch === null ? null : { start: batch.start, end: batch.end };
  let current = range?.start;
  const available = [...toolNames];
  let progress = null;
  return {
    allows(name, args) {
      if (!STEPS.has(name)) return true;
      if (!progress || (Object.hasOwn(args, "episode") && args.episode !== progress.ep.number)) return false;
      if (STEPS.get(name) === "sketches") return progress.project.characters > 0;
      if (name === "weaveclaw_compose_episode" || name === "weaveclaw_start_single_video") {
        return progress.ep.beats > 0 && progress.ep.audio_ready === progress.ep.beats;
      }
      return true;
    },
    observe(name, args, value) {
      if (name === "weaveclaw_get_creation_progress") {
        if (range && (current > range.end || args?.episode !== current)) return;
        progress = value?.ok === true && value.final === false ? facts(value.result, args?.episode) : null;
        if (range && progress && progress.active.size === 0 && completion(progress).step === STEPS.size) {
          current++;
          if (current <= range.end) progress = null;
        }
      }
    },
    plan() {
      const batchState = range ? { batch: { ...range, current } } : {};
      const allowed = new Set();
      let reason = null, next = null, checkpoint = false;
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
        const audioReady = ep.beats > 0 && ep.audio_ready === ep.beats;
        const videoReady = ep.beats > 0 && ep.video_present === ep.beats;
        permit("weaveclaw_detect_sketch_identities", sketchesReady);
        permit("weaveclaw_optimize_video_global", identitiesDetected);
        permit("weaveclaw_render_first_frames", identitiesDetected && videoPromptsReady);
        permit("weaveclaw_generate_audio", framesReady);
        permit("weaveclaw_start_single_video", framesReady && audioReady);
        permit("weaveclaw_compose_episode", framesReady && audioReady && videoReady);
        permit("weaveclaw_get_final_video", ep.composed);
        // Resume from the first missing prerequisite in fresh facts, not from
        // a session-local cursor; completed stages must not be suggested again.
        if (active.size) reason = "await_task";
        else if (!source.imported && !source.uploads) reason = "source_missing";
        else if (!source.imported) [reason, next] = ["ingest_required", "weaveclaw_start_ingest"];
        else if (!project.characters) [reason, next] = ["characters_required", "weaveclaw_build_characters"];
        // Optional recommendation only; existing pipeline tools stay available.
        else if (project.configured === false) [reason, checkpoint] = ["config_recommendation", true];
        else if (!project.episodes) [reason, next] = ["episodes_required", "weaveclaw_plan_episodes"];
        else if (!ep.exists) reason = null;
        else if (!ep.identity_planned) [reason, next] = ["identity_plan_required", "weaveclaw_plan_identities"];
        else if (!ep.beats || !ep.all_beats_have_content) [reason, next] = ["script_required", "weaveclaw_generate_script"];
        // Optional warning: old sketch batches may have inconsistent clothing.
        // Keep existing tool gates intact; regeneration remains available.
        else if (ep.sketches_stale > 0) [reason, checkpoint] = ["sketches_stale", true];
        else if (!sketchesReady) [reason, next] = ["sketches_required", "weaveclaw_generate_sketches"];
        else if (ep.identity_detected !== ep.beats) [reason, next] = ["identity_detection_required", "weaveclaw_detect_sketch_identities"];
        else if (ep.video_prompt_present === null) reason = null;
        else if (!videoPromptsReady) [reason, next] = ["global_optimize_required", "weaveclaw_optimize_video_global"];
         else if (!framesReady) [reason, next] = ["first_frames_required", "weaveclaw_render_first_frames"];
         // The host owns the retry counter; repeated planning cannot spend it.
         else if (ep.first_frames_quality === false && ep.retry_count === 0) [reason, next, checkpoint] = ["quality_retry", "weaveclaw_render_first_frames", true];
         else if (ep.audio_ready === null) reason = null;
         else if (!audioReady && ep.first_frames_quality === false && ep.retry_count >= 1) [reason, next] = ["audio_required", "weaveclaw_generate_audio"];
        else if (!audioReady && ep.audio_ready > 0) [reason, next] = ["audio_required", "weaveclaw_generate_audio"];
        else if (!audioReady) [reason, checkpoint] = ["review_first_frames", true];
        else if (ep.video_present === null) reason = null;
        else if (!videoReady) [reason, next] = ["video_required", "weaveclaw_start_single_video"];
        else if (ep.composed === null) reason = null;
        else if (!ep.composed) [reason, next] = ["compose_required", "weaveclaw_compose_episode"];
        else [reason, next] = ["delivery", "weaveclaw_get_final_video"];
      }
      const tools = available.filter((name) => !STEPS.has(name) || allowed.has(name));
      const feedback = completion(progress);
      const target = range ? current : last_episode;
      if (!progress && target !== null && tools.includes("weaveclaw_get_creation_progress")) {
        // last_episode identifies the target only. Read its facts before writes.
        return { tools, plan: { episode: target, next_tool: "weaveclaw_get_creation_progress", reason: "progress_required" }, progress: feedback, ...batchState };
      }
      if (next && !tools.includes(next)) return { tools, plan: null, progress: feedback, ...batchState };
      return { tools, plan: reason ? { episode: progress.ep.number, next_tool: next, reason, ...(checkpoint ? { checkpoint: true } : {}) } : null, progress: feedback, ...batchState };
    },
  };
}
