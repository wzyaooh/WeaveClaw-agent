import assert from "node:assert/strict";
import test from "node:test";
import { selectStrategy } from "../src/strategy.mjs";

const creation = selectStrategy([{}]);
const textOnly = selectStrategy([]);

test("episode context is optional and does not override an explicit new target", () => {
  assert.equal(selectStrategy([{}], null).text, creation.text);
  assert.ok(!creation.text.includes("当前正在处理第"));
  const resumed = selectStrategy([{}], 7);
  assert.ok(resumed.text.includes("当前正在处理第7集"));
  assert.ok(resumed.text.includes("用户明确指定新集数时，以用户指定为准"));
  assert.equal(selectStrategy([], 7).text, textOnly.text);
});

test("creation prompt keeps stable id and required behavior keywords", () => {
  assert.equal(creation.id, "creation-v1");
  for (const keyword of ["小织", "逐步确认", "自动推进", "错误即停", "交付边界"]) {
    assert.ok(creation.text.includes(keyword), `missing keyword: ${keyword}`);
  }
});

test("identity rule answers only 我是小织 without titles", () => {
  assert.ok(creation.text.includes("只简短回答"));
  assert.ok(creation.text.includes("我是小织"));
  assert.ok(creation.text.includes("不附加头衔或框架描述"));
});

test("big task entry splits work and asks before any write tool", () => {
  assert.ok(creation.text.includes("大任务入口"));
  assert.ok(creation.text.includes("第一轮不启动任何写工具"));
  assert.ok(creation.text.includes("询问是否先列出当前进度和建议下一步"));
});

test("execution modes default to asking the user and cap one write per turn", () => {
  assert.ok(creation.text.includes("默认先问用户选择"));
  assert.ok(creation.text.includes("用户没说明时主动问一句"));
  assert.ok(creation.text.includes("每轮最多一个写任务，启动后收口"));
  assert.ok(creation.text.includes("不轮询到完成"));
});

test("摄入后按小说内容一次性推荐配置且不覆盖已有选择", () => {
  for (const keyword of ["摄入完成后", "实际读取的小说内容", "visual_style", "narration_style", "ethnicity", "rhythm",
    "一次性推荐", "确认或修改", "不擅自覆盖已有配置", "config_recommendation", "可选检查点"]) {
    assert.ok(creation.text.includes(keyword), `missing recommendation rule: ${keyword}`);
  }
  assert.ok(!textOnly.text.includes("config_recommendation"));
});

test("audio update keeps fixed order across turns", () => {
  const { text } = creation;
  const patch = text.indexOf("先更新 beat 本身");
  const redo = text.indexOf("重做该 beat 音频");
  const compose = text.indexOf("触发合成");
  assert.ok(patch >= 0 && redo > patch && compose > redo, "PATCH beat → 重做音频 → 合成 order broken");
  assert.ok(text.includes("跨轮次"));
  assert.ok(text.includes("不跳过第一步"));
});

test("write failure stops the turn without retry", () => {
  assert.ok(creation.text.includes("错误即停"));
  assert.ok(creation.text.includes("停止所有后续工具调用"));
  assert.ok(creation.text.includes("不重试"));
});

test("parameter correction only applies before a write and keeps target and revision", () => {
  assert.ok(creation.text.includes("尚未发起写入"));
  assert.ok(creation.text.includes("相同目标和版本下修正一次"));
  assert.ok(creation.text.includes("缺少事实时询问用户，不猜测"));
});

test("each step delivers its own artifact via host display tools", () => {
  assert.ok(creation.text.includes("每步完成后展示对应产物"));
  assert.ok(creation.text.includes("草图→展示草图"));
  assert.ok(creation.text.includes("音频→展示音频"));
  assert.ok(creation.text.includes("媒体展示调用对应展示工具"));
  assert.ok(creation.text.includes("仅在宿主提供可靠的进度统计时"));
  assert.ok(creation.text.includes("不猜测数字"));
});

test("grounding and delivery red lines stay pinned", () => {
  assert.ok(creation.text.includes("不拼接 host"));
  assert.ok(creation.text.includes("不捏造完成结果"));
  assert.ok(creation.text.includes("不扩大交付范围"));
});

test("strategy texts satisfy host orchestrator contract", () => {
  for (const strategy of [creation, textOnly]) {
    assert.match(strategy.id, /^[a-z0-9][a-z0-9._-]{0,63}$/);
    assert.ok(strategy.text.trim().length > 0);
    assert.ok(strategy.text.length <= 8000);
    assert.ok(![...strategy.text].some((char) => {
      const code = char.codePointAt(0);
      return (code >= 0xd800 && code <= 0xdfff) || (code < 32 && !"\n\r\t".includes(char));
    }), "surrogate or control character in strategy text");
  }
});

test("text-only strategy claims no task execution", () => {
  assert.equal(textOnly.id, "text-only-v1");
  assert.ok(textOnly.text.includes("小织"));
  assert.ok(textOnly.text.includes("不要声称执行了任何任务"));
});
