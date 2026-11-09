# WeaveClaw 创作 Agent

本项目是 WeaveClaw 的独立关联项目。当前阶段提供 Pi 轮次适配和本地传输原型，并构建供 Electron utilityProcess 使用的 `dist/orchestrator.cjs`。主仓库已接入宿主模型调用和业务操作；Pi 接收限长请求、文本历史、工具定义、模型结果及受控业务结果；宿主仍负责模型和业务授权。安装后的桌面端到端验收尚未完成。

首期产品和流程规则见 [创作流程规则](docs/creation-workflow.md)。

安装依赖并运行不调用真实模型的验证：

```powershell
npm ci --ignore-scripts
npm run build
npm test
$env:ELECTRON_BIN = 'E:\WeaveClaw\desktop\node_modules\electron\dist\electron.exe'
npm run test:electron
```

`ELECTRON_BIN` 应指向 Electron 的实际可执行文件，例如 Windows 下的 `electron.exe`。

模拟验证不代表业务权限、计费、断线恢复或安装包端到端验收通过。宿主已实现相关控制与自动化回归，但真实桌面创作流程仍需单独验收。

当前使用 Pi Agent Core 1.5.0；在 WeaveClaw 锁定的 Electron 38.8.6（Node 22.22.0）下完成过上述模拟验证。Python 宿主与 Pi 均在执行前校验工具批次；实际授权、执行和回执仍由宿主控制。

打包脚本校验依赖清单和许可证，并生成单文件产物；安装后实际桌面运行仍需验收。

2026-11-09 本机 Electron 门禁输出（本次上下文协议变更前的历史记录，不代表新协议已通过 Electron 验证）：

```json
{"ok":true,"node":"22.22.0","checks":["single_write","complete_before_tool","multiple_writes_blocked","truncated_response_blocked","cancelled_during_stream","host_owned_turn"],"electron":"38.8.6"}
{"ok":true,"electron":"38.8.6","checks":["local_socket","host_owned_write"]}
{"ok":true,"checks":["invalid_start","early_stop","unsafe_environment","disconnect_reported","stop_during_handshake"]}
```


与 WeaveClaw 主仓库开发环境联调（主仓库必须包含协议版本 2 和支持真实工具 Schema、模型文本与参数以及 `tool.result.result` 的提交，且打包清单固定到本关联项目提交；需要该仓库的 Python 依赖；使用模拟模型和业务写入，不调用真实模型）：

```powershell
E:\WeaveClaw\.venv\Scripts\python.exe test/python-host-gate.py
$env:WEAVECLAW_TEST_ELECTRON = 'E:\WeaveClaw\desktop\node_modules\electron\dist\electron.exe'
E:\WeaveClaw\.venv\Scripts\python.exe test/python-host-gate.py
```

上述命令分别用于验证独立 Node 进程源码和 Electron utilityProcess 单文件产物，通过本地 WebSocket 连接 Python 协议、认证及宿主编排原型。协议版本 2 已完成 Node 源码联调；Electron、安装包和真实业务流程尚未验收。Electron 测试使用合成令牌并通过父进程传递给子进程。Python 导入时可能生成本地 `runtime/` 日志目录，该目录不纳入版本控制。

## Electron 进程入口

构建产物 `dist/orchestrator.cjs` 由 Electron `utilityProcess.fork` 启动。父进程必须显式提供精简环境：Windows 只能传 `{ SystemRoot }`，其他平台传 `{}`；入口会拒绝任何其他环境键。不得继承 `WEAVECLAW_*`、模型密钥、`NODE_OPTIONS` 或其他凭据。仅通过 `parentPort` 发送 `{type: "start", url, token}` 和 `{type: "stop"}`，其中 token 是每次启动单独生成的本地编排令牌。子进程回复 `{type: "ready"}` 或 `{type: "error", code}`；收到 `ready` 后也可能因断线收到 `error`。错误码为 `unsafe_environment`、`invalid_message`、`invalid_start`、`already_started`、`connection_failed`、`host_disconnected`、`protocol_error`、`internal_error`。正常停止以 0 退出，启动失败或连接意外断开以 1 退出。令牌不得写入 URL、日志或前端。

`npm run build` 对依赖输入和环境读取执行构建检查。主项目安装包已纳入单文件产物及许可声明；还需验证安装后的完整生命周期和真实业务。

宿主在本地连接中向 Pi 提供限长请求、文本历史、工具定义、完整模型输出和经宿主处理的业务结果。模型调用仍使用宿主权威上下文，Pi 自身上下文尚未用于构建模型请求；Pi 不能直接持有凭据或绕过宿主授权。真实安装后的创作流程仍待验收。

本地协议版本为 2，不兼容旧协议；版本不匹配在模型调用前关闭连接。`turn.start` payload 必须恰好包含 `prompt`、`history` 和 `tools`。`prompt` 必须非空且最多 24000 个 Unicode 码点；`history` 最多 40 条、文本合计最多 48000 个码点，每条只能含非空 `content` 和 `role`（`user` 或 `assistant`）。宿主需过滤 system、工具和空文本历史，按同样规则截断。旧 `{tools}` 帧不受支持；协议违规会关闭整条连接并中止其余并发轮次。工具参数、结果经本地 Pi 传递；宿主只执行自己验证过的参数并负责授权。

`model.result.parts` 含文本或工具调用（ID、名称、参数）；发送之前和执行之前均进行整批校验，不接受重复 ID、类型转换或无效 Schema。`tool.result` 必须恰好包含布尔值 `ok`、`final` 和对象 `result`；按紧凑 `JSON.stringify` 结果的 UTF-8 字节数计算，`result` 不得超过 256000 字节。帧结构或结果大小违反协议会关闭整条连接并使其他并发轮次失败；重复 ID、类型不符或 Schema 不匹配只终止当前轮次。工具参数中的整数必须处于 JavaScript 安全整数范围，超大 ID 应使用字符串。宿主应为消息封装留出余量。
