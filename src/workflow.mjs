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
// Auxiliary planners are gated but do not add fictitious completion stages.
const ASSET_PLANNERS = new Set(["weaveclaw_plan_scenes", "weaveclaw_plan_props"]);
const RECOMMENDATION_TOOLS = new Set(["weaveclaw_get_config_recommendation_context", "weaveclaw_propose_config_recommendation"]);
const QUALITY_TOOLS = new Set(["weaveclaw_verify_first_frames"]);
// Each is an independent, single-request, read-only project query. The host
// maintains its own identical allowlist and remains the authority.
export const PARALLEL_READS = new Set(["weaveclaw_get_project", "weaveclaw_list_characters", "weaveclaw_list_episodes",
  "weaveclaw_list_scenes", "weaveclaw_list_props", "weaveclaw_get_episode_script", "weaveclaw_pipeline_status"]);
const count = (x) => Number.isSafeInteger(x) && x >= 0;
// Distinct names for the progress checkpoints; several tools share a task stage.
const CHECKPOINTS = ["ingest", "characters", "episodes", "identity_plan", "script", "sketch_colors",
  "sketches", "identity_detection", "global_optimize", "first_frames", "audio", "video", "compose", "delivery"];

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
      beatsReady && ep.first_frames_present === ep.beats && (ep.first_frames_quality !== false || ep.first_frames_user_accepted),
      beatsReady && ep.audio_current !== null && ep.audio_current + ep.audio_confirmed === ep.beats,
      beatsReady && ep.video_current !== null && ep.video_current + ep.video_confirmed === ep.beats,
      ep.composed_freshness === "current" || ep.composition_confirmed,
      ep.composed_freshness === "current" || ep.composition_confirmed,
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
  const groups = [["audio_current", "audio_stale", "audio_unknown"], ["video_current", "video_stale", "video_unknown"]];
  const invalidFreshness = ep && groups.some((keys) => {
    const defined = keys.filter((key) => ep[key] !== undefined).length;
    return defined !== 0 && (defined !== keys.length || keys.some((key) => !count(ep[key])) ||
      keys.reduce((total, key) => total + ep[key], 0) > ep.beats);
  });
  if (!data || data.version !== 1 || !source || !project || !ep || ep.number !== episode || !Number.isSafeInteger(episode) || episode < 1 || episode > 10000 ||
      !count(source.uploads) || typeof source.imported !== "boolean" ||
      (source.ingest !== undefined && !["not_observed", "running", "completed", "failed", "cancelled"].includes(source.ingest)) ||
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
      (ep.composed !== undefined && typeof ep.composed !== "boolean") || invalidFreshness ||
      (ep.audio_confirmed !== undefined && (!count(ep.audio_confirmed) || ep.audio_unknown === undefined || ep.audio_confirmed > ep.audio_unknown)) ||
      (ep.video_confirmed !== undefined && (!count(ep.video_confirmed) || ep.video_unknown === undefined || ep.video_confirmed > ep.video_unknown)) ||
      (ep.composition_confirmed !== undefined && (typeof ep.composition_confirmed !== "boolean" ||
        (ep.composition_confirmed && ep.composed_freshness !== "unknown"))) ||
      (ep.composed_freshness !== undefined && !["missing", "current", "stale", "unknown"].includes(ep.composed_freshness)) ||
      (ep.composed_freshness !== undefined && ep.composed !== undefined &&
        (ep.composed_freshness === "missing") === ep.composed) ||
       (ep.first_frames_quality !== undefined && typeof ep.first_frames_quality !== "boolean") ||
       (ep.first_frames_user_accepted !== undefined && (typeof ep.first_frames_user_accepted !== "boolean" ||
         (ep.first_frames_user_accepted && ep.first_frames_quality !== false))) ||
       (ep.retry_count !== undefined && !count(ep.retry_count)) ||
      !Array.isArray(active) || active.some((item) => !ACTIVE.has(item)) || new Set(active).size !== active.length) return null;
  return {
    source: { uploads: source.uploads, imported: source.imported, ingest: source.ingest ?? null },
    project: { characters: project.characters, episodes: project.episodes, configured: project.configured ?? null },
    ep: { number: ep.number, exists: ep.exists, identity_planned: ep.identity_planned, beats: ep.beats,
      all_beats_have_content: ep.all_beats_have_content, sketches_missing: ep.sketches_missing,
       sketches_stale: ep.sketches_stale, identity_detected: ep.identity_detected, first_frames_present: ep.first_frames_present,
      first_frames_quality: ep.first_frames_quality ?? null,
      first_frames_user_accepted: ep.first_frames_user_accepted === true,
      retry_count: ep.retry_count ?? null,
      video_prompt_present: ep.video_prompt_present ?? null,
      audio_present: ep.audio_present ?? null,
      audio_ready: ep.audio_ready ?? ep.audio_present ?? null,
      video_present: ep.video_present ?? null,
      audio_current: ep.audio_current ?? null, audio_stale: ep.audio_stale ?? null, audio_unknown: ep.audio_unknown ?? null,
      video_current: ep.video_current ?? null, video_stale: ep.video_stale ?? null, video_unknown: ep.video_unknown ?? null,
      composed_freshness: ep.composed_freshness ?? null,
      audio_confirmed: ep.audio_confirmed ?? 0, video_confirmed: ep.video_confirmed ?? 0,
      composition_confirmed: ep.composition_confirmed === true,
      composed: ep.composed ?? null },
    active: new Set(active),
  };
}

export function createWorkflow(toolNames, last_episode = null, batch = null, scope = "project") {
  if (batch !== null && (!Number.isSafeInteger(batch.start) || !Number.isSafeInteger(batch.end) ||
      batch.start < 1 || batch.end > 10000 || batch.start > batch.end || batch.end - batch.start + 1 > 20 ||
      (batch.current !== undefined && (!Number.isSafeInteger(batch.current) || batch.current < batch.start || batch.current > batch.end)) ||
      (batch.allow_write !== undefined && typeof batch.allow_write !== "boolean") ||
      (batch.quality_required !== undefined && typeof batch.quality_required !== "boolean"))) throw new RangeError("invalid_batch");
  // Copy caller-owned bounds; each episode requires its own fresh facts.
  const range = batch === null ? null : { start: batch.start, end: batch.end };
  let current = batch?.current ?? range?.start;
  const available = [...toolNames];
  let progress = null;
  let progressProject = null;
  let recommendationContext = null, recommendations = null;
  const sameTarget = (args) => progress && args?.episode === progress.ep.number &&
    (scope === "project" ? progressProject === null || args.project_id == null || args.project_id === progressProject
      : progressProject !== null && args.project_id === progressProject);
  const recommendationReady = () => progress && progress.source.imported && progress.source.ingest === "completed" && progress.project.configured === false &&
    !progress.active.has("ingest") && (scope === "project" || progressProject !== null);
  const beatsReady = () => progress !== null && progress.ep.exists && progress.ep.beats > 0 &&
    progress.ep.all_beats_have_content && !progress.active.has("script");
  return {
    allows(name, args) {
      if (range && name === "weaveclaw_get_creation_progress") return current <= range.end && args?.episode === current;
      if (RECOMMENDATION_TOOLS.has(name)) {
        if (!recommendationReady() || !sameTarget(args)) return false;
        return name === "weaveclaw_get_config_recommendation_context" ||
          (recommendationContext !== null && args.source_sha256 === recommendationContext.source_sha256 &&
           args.expected_revision === recommendationContext.expected_revision);
      }
      if (name === "weaveclaw_update_project" && recommendationContext &&
          ["visual_style", "narration_style", "ethnicity", "rhythm"].some((key) => Object.hasOwn(args ?? {}, key))) return false;
      if (ASSET_PLANNERS.has(name)) {
        if (!beatsReady() || args?.episode !== progress.ep.number) return false;
        const target = args?.project_id ?? null;
        // In project scope Python binds the implicit project; home requires an
        // explicit project on both the progress read and the planner write.
        return scope === "project"
          ? progressProject === null || target === null || target === progressProject
          : progressProject !== null && target === progressProject;
      }
      if (!STEPS.has(name)) return true;
      if (!progress || (Object.hasOwn(args, "episode") && args.episode !== progress.ep.number)) return false;
      if (last_episode === progress.ep.number && !progress.ep.exists && Object.hasOwn(args, "episode")) return false;
      if (STEPS.get(name) === "sketches") return progress.project.characters > 0;
      if (name === "weaveclaw_get_final_video") return progress.ep.beats > 0 &&
        progress.ep.audio_current !== null && progress.ep.audio_current + progress.ep.audio_confirmed === progress.ep.beats &&
        progress.ep.video_current !== null && progress.ep.video_current + progress.ep.video_confirmed === progress.ep.beats &&
        (progress.ep.composed_freshness === "current" || progress.ep.composition_confirmed);
      if (name === "weaveclaw_compose_episode" || name === "weaveclaw_start_single_video") {
        return progress.ep.beats > 0 && progress.ep.audio_current !== null &&
          progress.ep.audio_current + progress.ep.audio_confirmed === progress.ep.beats &&
          (name !== "weaveclaw_compose_episode" || (progress.ep.video_current !== null &&
            progress.ep.video_current + progress.ep.video_confirmed === progress.ep.beats));
      }
      return true;
    },
    observe(name, args, value) {
      if (name === "weaveclaw_get_creation_progress") {
        if (range && (current > range.end || args?.episode !== current)) return;
        progress = value?.ok === true && value.final === false ? facts(value.result, args?.episode) : null;
        progressProject = progress && typeof args?.project_id === "string" ? args.project_id : null;
        recommendationContext = null;
        recommendations = null;
        if (range && progress && progress.active.size === 0 && !["running", "failed", "cancelled"].includes(progress.source.ingest) && completion(progress).step === STEPS.size && (!batch.quality_required || progress.ep.first_frames_quality === true || progress.ep.first_frames_user_accepted)) {
          current++;
          if (current <= range.end) progress = null;
        }
      } else if (name === "weaveclaw_get_config_recommendation_context") {
        const data = value?.ok === true && value.final === false && value.result?.ok === true ? value.result.data : null;
        recommendationContext = sameTarget(args) && data && /^[0-9a-f]{64}$/.test(data.source_sha256) &&
          /^[0-9a-f]{32}$/.test(data.expected_revision) ? { source_sha256: data.source_sha256, expected_revision: data.expected_revision } : null;
        recommendations = null;
      } else if (name === "weaveclaw_propose_config_recommendation") {
        const data = value?.ok === true && value.final === false && value.result?.ok === true ? value.result.data : null;
        recommendations = sameTarget(args) && data && recommendationContext &&
          data.source_sha256 === recommendationContext.source_sha256 && data.expected_revision === recommendationContext.expected_revision &&
          data.recommendations && typeof data.recommendations === "object" ? { ...data.recommendations } : null;
      }
    },
    plan() {
      const batchState = range ? { batch: { ...range, current },
        batch_episodes: Array.from({ length: range.end - range.start + 1 }, (_, index) => range.start + index) } : {};
      const allowed = new Set();
      let reason = null, next = null, checkpoint = false;
      if (progress) {
        const { source, project, ep, active } = progress;
        const permit = (name, condition) => { if (condition && !active.has(STEPS.get(name))) allowed.add(name); };
        if (beatsReady() && (scope === "project" || progressProject !== null)) {
          for (const name of ASSET_PLANNERS) allowed.add(name);
        }
        if (recommendationReady()) {
          allowed.add("weaveclaw_get_config_recommendation_context");
          if (recommendationContext) allowed.add("weaveclaw_propose_config_recommendation");
        }
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
        const qualityUsable = ep.first_frames_quality !== false || ep.first_frames_user_accepted;
        if (batch?.quality_required && framesReady && ep.first_frames_quality === null) allowed.add("weaveclaw_verify_first_frames");
        const audioReady = ep.beats > 0 && ep.audio_current !== null && ep.audio_current + ep.audio_confirmed === ep.beats;
        const videoReady = ep.beats > 0 && ep.video_current !== null && ep.video_current + ep.video_confirmed === ep.beats;
        permit("weaveclaw_detect_sketch_identities", sketchesReady);
        permit("weaveclaw_optimize_video_global", identitiesDetected);
        permit("weaveclaw_render_first_frames", identitiesDetected && videoPromptsReady);
        permit("weaveclaw_generate_audio", framesReady && qualityUsable);
        permit("weaveclaw_start_single_video", framesReady && qualityUsable && audioReady);
        permit("weaveclaw_compose_episode", framesReady && qualityUsable && audioReady && videoReady);
        permit("weaveclaw_get_final_video", qualityUsable && audioReady && videoReady && (ep.composed_freshness === "current" || ep.composition_confirmed));
        // Resume from the first missing prerequisite in fresh facts, not from
        // a session-local cursor; completed stages must not be suggested again.
        if (last_episode === ep.number && !ep.exists) [reason, checkpoint] = ["episode_missing", true];
        else if (active.size) reason = "await_task";
        else if (!source.imported && !source.uploads) reason = "source_missing";
        else if (!source.imported) [reason, next] = ["ingest_required", "weaveclaw_start_ingest"];
        // Optional recommendation only; existing pipeline tools stay available.
        else if (recommendationReady() && !recommendations) [reason, checkpoint] = ["config_recommendation", true];
        else if (!project.characters) [reason, next] = ["characters_required", "weaveclaw_build_characters"];
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
         else if (batch?.quality_required && ep.first_frames_quality === null) [reason, next] = ["quality_verify_required", "weaveclaw_verify_first_frames"];
         // The host owns the retry counter; repeated planning cannot spend it.
         else if (!qualityUsable && ep.retry_count === 0) [reason, next, checkpoint] = ["quality_retry", "weaveclaw_render_first_frames", true];
         else if (!qualityUsable) [reason, checkpoint] = ["quality_failed", true];
         else if (ep.audio_current === null || ep.audio_unknown > ep.audio_confirmed) [reason, checkpoint] = ["audio_unknown", true];
         else if (ep.audio_stale > 0) [reason, checkpoint] = ["audio_stale", true];
        else if (!audioReady && ep.audio_current > 0) [reason, next] = ["audio_required", "weaveclaw_generate_audio"];
        else if (!audioReady) [reason, checkpoint] = ["review_first_frames", true];
        else if (ep.video_current === null || ep.video_unknown > ep.video_confirmed) [reason, checkpoint] = ["video_unknown", true];
        else if (ep.video_stale > 0) [reason, checkpoint] = ["video_stale", true];
        else if (!videoReady) [reason, next] = ["video_required", "weaveclaw_start_single_video"];
        else if (ep.composed === null) reason = null;
        else if (!ep.composed) [reason, next] = ["compose_required", "weaveclaw_compose_episode"];
        else if (ep.composed_freshness === null || (ep.composed_freshness === "unknown" && !ep.composition_confirmed)) [reason, checkpoint] = ["composition_unknown", true];
        else if (ep.composed_freshness === "stale") [reason, checkpoint] = ["composition_stale", true];
        else [reason, next] = ["delivery", "weaveclaw_get_final_video"];
      }
      const tools = available.filter((name) => !(name === "weaveclaw_update_project" && recommendationContext) &&
        ((!STEPS.has(name) && !ASSET_PLANNERS.has(name) && !RECOMMENDATION_TOOLS.has(name) && !QUALITY_TOOLS.has(name)) || allowed.has(name)));
      const parallel_tools = tools.filter((name) => PARALLEL_READS.has(name));
      const feedback = completion(progress);
      // Only the verified completed prefix is skipped. It is recalculated on
      // every fresh observation and never infers completion from a write reply.
      const skipped = CHECKPOINTS.slice(0, feedback.step);
      const target = range ? current : last_episode;
      if (!progress && target !== null && tools.includes("weaveclaw_get_creation_progress")) {
        // last_episode identifies the target only. Read its facts before writes.
        return { tools, plan: { episode: target, next_tool: "weaveclaw_get_creation_progress", reason: "progress_required" }, progress: feedback, skipped, parallel_tools, ...batchState };
      }
      if (next && !tools.includes(next)) return { tools, plan: null, progress: feedback, skipped, parallel_tools, ...batchState };
      return { tools, plan: reason ? { episode: progress.ep.number, next_tool: next, reason, ...(checkpoint ? { checkpoint: true } : {}) } : null, progress: feedback, skipped, parallel_tools, ...(recommendations ? { recommendations } : {}), ...batchState };
    },
  };
}
