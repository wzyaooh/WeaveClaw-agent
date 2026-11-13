# WeaveClaw Creative Agent

WeaveClaw Creative Agent 是 WeaveClaw 桌面端的本地创作编排组件。它基于 Pi Agent Core 组织单轮对话、规划创作步骤，并通过本地 WebSocket 向 WeaveClaw 宿主请求模型调用和业务工具执行。创作助手在对话中使用“小织”这一名称。

本仓库不是独立的视频生成应用，也没有面向用户的独立启动界面。模型、项目数据、业务操作、权限、确认和计费由 WeaveClaw 宿主负责；本组件不直接持有模型凭据，也不直接调用业务 API。实际可用的工具和功能取决于宿主提供的工具定义及协议版本。

## 能做什么

- 根据宿主返回的目标集实时进度，建议下一步，并控制创作流水线工具的可用性：导入、角色与分集规划、身份规划、脚本、草图、身份检测、视频提示词优化、首帧、音频、逐 beat 视频、合成和成片展示。
- 支持逐步确认和自动推进的对话策略；整集任务先拆解，单轮写入上限和业务授权由宿主配合执行。写入提交后根据宿主回执结束本轮，不把提交当作完成。
- 支持目标集续接和最多 20 集的批量规划。每集都要重新读取进度；跨轮调度、任务状态及恢复由宿主负责，本仓库的规划本身不代表任务已自动排队或完成。
- 在条件满足时提供配置推荐、草图过期提示和首帧审查；批量场景可根据宿主提供的质量结果建议首帧重试或暂停。
- 区分素材的当前、过期和来源未知状态。未知素材需要用户在宿主界面确认；文件存在不等于内容有效或与当前脚本一致。
- 校验宿主提供的工具 Schema 和模型返回的整批工具参数；对允许的独立只读工具支持并行请求，业务结果和权限仍以宿主为准。

更详细的产品规则与实现边界见 [创作流程规则](docs/creation-workflow.md)。

## 工作方式

```text
WeaveClaw 桌面进程
  └─ Electron utilityProcess: dist/orchestrator.cjs
       └─ 本地认证 WebSocket（协议 v2）
            └─ WeaveClaw Python 宿主 → 模型 / 受控业务工具
```

宿主通过父进程消息启动编排进程，并提供单次启动的本地令牌。每轮由宿主提供请求、文本历史、工具定义和限制；Pi 根据进度产生策略和计划，向宿主请求模型或工具调用。模型请求的上下文采用对宿主已知消息的引用，宿主保有权威上下文。模型完整返回后，本组件先校验整批工具调用，再交由宿主验证、授权和执行。

本组件的策略提示要求单轮最多启动一个写任务、失败后停止，并将音频字段修改、音频重做和合成安排在不同轮次；这些对话策略不能替代宿主的业务校验。有限的本地参数修正仅适用于宿主明确表示尚未发起写入的情况。

## 环境与构建

- Node.js 22.19.0 或更高版本，及 npm。
- `npm ci` 所需的依赖获取条件；Pi 相关依赖固定为 1.5.0。
- 运行 Electron 验证时，需要 Electron 可执行文件；Python 联调还需要兼容的 WeaveClaw 主仓库及其 Python 环境。

在本仓库根目录执行：

```powershell
npm ci --ignore-scripts
npm run build
npm test
```

构建生成 `dist/orchestrator.cjs`，供 Electron `utilityProcess.fork` 加载。构建脚本将代码打包为单文件，并检查依赖输入、外部依赖、动态导入和环境读取。`dist/`、`node_modules/` 和 `runtime/` 不纳入版本控制。

## 验证

`npm test` 使用 Node 内置测试运行器，覆盖工作流、策略、上下文投影、工具参数、传输、进程管理和 Pi 轮次等行为。测试使用模拟模型和业务结果，不调用真实模型。

使用 Electron 验证打包产物和 utilityProcess 行为。将路径替换为实际 Electron 可执行文件：

```powershell
$env:ELECTRON_BIN = 'E:\WeaveClaw\desktop\node_modules\electron\dist\electron.exe'
npm run test:electron
```

该命令会先构建，再运行 Pi、传输和进程管理的 Electron 门禁。

与 WeaveClaw Python 宿主进行本地联调需要兼容协议 v2 和本仓库测试所依赖的宿主接口，以及已安装主仓库 Python 依赖的环境。以下路径仅为 Windows 示例，命令从本仓库根目录执行：

```powershell
# Node 源码客户端（清除此前设置的 Electron 路径）
Remove-Item Env:WEAVECLAW_TEST_ELECTRON -ErrorAction SilentlyContinue
E:\WeaveClaw\.venv\Scripts\python.exe test/python-host-gate.py

# Electron utilityProcess 打包产物（先运行 npm run build）
$env:WEAVECLAW_TEST_ELECTRON = 'E:\WeaveClaw\desktop\node_modules\electron\dist\electron.exe'
E:\WeaveClaw\.venv\Scripts\python.exe test/python-host-gate.py
```

不设置 `WEAVECLAW_TEST_ELECTRON` 时，测试使用 PATH 中的 Node；也可通过 `WEAVECLAW_TEST_NODE` 指定 Node 可执行文件。联调使用模拟模型、测试数据和本地业务请求，不代表真实模型、安装包或完整桌面创作流程已通过验收。

2026-11-13 文档核对时，本机 Node 24.21.0 的构建和 135 项测试、Electron 38.8.6（Node 22.22.0）门禁，以及上述两种 Python 宿主模拟联调均通过。结果仅适用于当时的代码和环境。

## 宿主集成约定

- 使用协议版本 2；旧版本不兼容。WebSocket 地址必须为 `ws://127.0.0.1:<端口>/api/v1/desktop/orchestrator/ws`，令牌通过请求头传输，不放入 URL。
- 父进程显式传入精简环境：Windows 仅传 `{ SystemRoot }`，其他平台传 `{}`。入口拒绝其他环境键；不要继承模型密钥、`WEAVECLAW_*` 或 `NODE_OPTIONS`。
- 父进程通过 `parentPort` 发送 `{ type: "start", url, token }` 启动，或发送 `{ type: "stop" }` 停止。子进程回复 `ready` 或 `error`；连接成功后断线也可能报告错误。正常停止退出码为 0，启动失败或连接意外断开为 1。
- `turn.start` 必须包含 `prompt`、`history`、`tools`、`scope` 和 `limits`，可选 `last_episode` 与 `batch`。请求最多 24,000 个 Unicode 码点；历史最多 40 条、合计 48,000 个码点，且只包含非空的 `user` 或 `assistant` 文本。
- `model.call` 发送上下文引用、可用工具和计划；工具调用参数必须符合宿主提供的 Schema，整数须在 JavaScript 安全整数范围内。`tool.result` 必须包含 `ok`、`final` 和对象 `result`，其中 `result` 的紧凑 JSON 最多 256,000 UTF-8 字节。
- 本地帧最大 2 MiB。协议帧错误或连接断开会中止该连接上的活动轮次；工具批次参数无效则在执行前终止当前轮次。宿主仍需独立校验、授权并处理业务回执。

入口和协议的实际约束见 [supervisor.mjs](src/supervisor.mjs)、[transport.mjs](src/transport.mjs) 和 [turn.mjs](src/turn.mjs)；对接时应同时核对宿主版本。

## 目录

```text
src/
  main.mjs        Electron utilityProcess 入口
  supervisor.mjs  启停、环境及连接生命周期管理
  transport.mjs   本地 WebSocket 协议和轮次路由
  turn.mjs        Pi 轮次、模型和工具调用校验
  context.mjs     宿主上下文引用投影
  strategy.mjs    助手对话策略
  workflow.mjs    创作进度、前置条件和步骤建议
scripts/          打包与产物检查
test/             Node、Electron 和 Python 宿主模拟验证
docs/             创作流程规则
```
