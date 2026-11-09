/** Local workflow suggestions; the host still owns authorization and effects. */
const STEPS = new Map([
  ["dramaclaw_start_ingest", "ingest"],
  ["dramaclaw_build_characters", "characters"],
  ["dramaclaw_plan_episodes", "episodes"],
  ["dramaclaw_plan_identities", "identity_plan"],
  ["dramaclaw_generate_script", "script"],
  ["dramaclaw_assign_sketch_colors", "sketches"],
  ["dramaclaw_generate_sketches", "sketches"],
  ["dramaclaw_detect_sketch_identities", "sketches"],
  ["dramaclaw_render_first_frames", "first_frames"],
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
      !Array.isArray(active) || active.some((item) => !ACTIVE.has(item)) || new Set(active).size !== active.length) return null;
  return {
    source: { uploads: source.uploads, imported: source.imported },
    project: { characters: project.characters, episodes: project.episodes },
    ep: { number: ep.number, exists: ep.exists, identity_planned: ep.identity_planned, beats: ep.beats,
      all_beats_have_content: ep.all_beats_have_content, sketches_missing: ep.sketches_missing,
      sketches_stale: ep.sketches_stale, identity_detected: ep.identity_detected, first_frames_present: ep.first_frames_present },
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
      if (name === "dramaclaw_get_creation_progress") {
        progress = value?.ok === true && value.final === false ? facts(value.result, args?.episode) : null;
      }
    },
    plan() {
      const allowed = new Set();
      let reason = null, next = null;
      if (progress) {
        const { source, project, ep, active } = progress;
        const permit = (name, condition) => { if (condition && !active.has(STEPS.get(name))) allowed.add(name); };
        permit("dramaclaw_start_ingest", source.uploads > 0);
        permit("dramaclaw_build_characters", source.imported);
        permit("dramaclaw_plan_episodes", source.imported && project.characters > 0 && (project.episodes === 0 || ep.exists));
        permit("dramaclaw_plan_identities", ep.exists && project.characters > 0);
        permit("dramaclaw_generate_script", ep.exists && ep.identity_planned);
        permit("dramaclaw_assign_sketch_colors", ep.exists && ep.beats > 0);
        permit("dramaclaw_generate_sketches", ep.exists && ep.beats > 0 && ep.all_beats_have_content);
        const sketchesReady = ep.beats > 0 && ep.sketches_missing === 0 && ep.sketches_stale === 0;
        permit("dramaclaw_detect_sketch_identities", sketchesReady);
        permit("dramaclaw_render_first_frames", sketchesReady && ep.identity_detected === ep.beats);
        if (active.size) reason = "await_task";
        else if (!source.imported && !source.uploads) reason = "source_missing";
        else if (!source.imported) [reason, next] = ["ingest_required", "dramaclaw_start_ingest"];
        else if (!project.characters) [reason, next] = ["characters_required", "dramaclaw_build_characters"];
        else if (!project.episodes) [reason, next] = ["episodes_required", "dramaclaw_plan_episodes"];
        else if (!ep.exists) reason = null;
        else if (!ep.identity_planned) [reason, next] = ["identity_plan_required", "dramaclaw_plan_identities"];
        else if (!ep.beats || !ep.all_beats_have_content) [reason, next] = ["script_required", "dramaclaw_generate_script"];
        else if (!sketchesReady) [reason, next] = ["sketches_required", "dramaclaw_generate_sketches"];
        else if (ep.identity_detected !== ep.beats) [reason, next] = ["identity_detection_required", "dramaclaw_detect_sketch_identities"];
        else if (ep.first_frames_present !== ep.beats) [reason, next] = ["first_frames_required", "dramaclaw_render_first_frames"];
        else reason = "review_first_frames";
      }
      const tools = available.filter((name) => !STEPS.has(name) || allowed.has(name));
      if (next && !tools.includes(next)) return { tools, plan: null };
      return { tools, plan: reason ? { episode: progress.ep.number, next_tool: next, reason } : null };
    },
  };
}
