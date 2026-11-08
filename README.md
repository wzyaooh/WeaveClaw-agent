# WeaveClaw 创作 Agent

本项目是 WeaveClaw 的独立关联项目。当前阶段包含 Pi 轮次适配和本地传输原型，并构建供 Electron utilityProcess 使用的 `dist/orchestrator.cjs`。真实 WeaveClaw 桌面启动、模型、任务和项目数据尚未接通。

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

模拟验证不代表业务权限、计费、断线恢复或安装包验收通过。这些能力仍需在 WeaveClaw 宿主实现并分别验证。

当前使用 Pi Agent Core 1.5.0；在 WeaveClaw 锁定的 Electron 38.8.6（Node 22.22.0）下完成过上述模拟验证。工具批次校验目前只是原型，正式版本仍须由 Python 宿主完成整批校验并控制实际写操作。

Pi 依赖还包含多个模型供应商 SDK；依赖裁剪、安装包大小与 Windows 路径长度需在打包阶段验证。

2026-11-09 本机 Electron 门禁输出：

```json
{"ok":true,"node":"22.22.0","checks":["single_write","complete_before_tool","multiple_writes_blocked","truncated_response_blocked","cancelled_during_stream","host_owned_turn"],"electron":"38.8.6"}
{"ok":true,"electron":"38.8.6","checks":["local_socket","host_owned_write"]}
{"ok":true,"checks":["invalid_start","early_stop","unsafe_environment","disconnect_reported","stop_during_handshake"]}
```


与 WeaveClaw 主仓库开发环境联调（需要该仓库的 Python 依赖；使用模拟模型和业务写入，不调用真实模型）：

```powershell
E:\WeaveClaw\.venv\Scripts\python.exe test/python-host-gate.py
$env:WEAVECLAW_TEST_ELECTRON = 'E:\WeaveClaw\desktop\node_modules\electron\dist\electron.exe'
E:\WeaveClaw\.venv\Scripts\python.exe test/python-host-gate.py
```

此验证分别通过独立 Node 进程和 Electron utilityProcess 的单文件产物，使用真实本地 WebSocket 连接 Python 协议、认证及宿主编排原型；尚不验证 Electron 打包或真实业务流程。Electron 测试使用合成令牌并通过父进程传递给子进程。Python 导入时可能生成本地 `runtime/` 日志目录，该目录不纳入版本控制。

## Electron 进程入口

构建产物 `dist/orchestrator.cjs` 由 Electron `utilityProcess.fork` 启动。父进程必须显式提供精简环境：Windows 只能传 `{ SystemRoot }`，其他平台传 `{}`；入口会拒绝任何其他环境键。不得继承 `WEAVECLAW_*`、模型密钥、`NODE_OPTIONS` 或其他凭据。仅通过 `parentPort` 发送 `{type: "start", url, token}` 和 `{type: "stop"}`，其中 token 是每次启动单独生成的本地编排令牌。子进程回复 `{type: "ready"}` 或 `{type: "error", code}`；收到 `ready` 后也可能因断线收到 `error`。错误码为 `unsafe_environment`、`invalid_message`、`invalid_start`、`already_started`、`connection_failed`、`host_disconnected`、`protocol_error`、`internal_error`。正常停止以 0 退出，启动失败或连接意外断开以 1 退出。令牌不得写入 URL、日志或前端。

`npm run build` 对依赖输入和环境读取执行构建检查。主项目安装包仍需纳入单文件产物、相关第三方许可声明，并验证生命周期和真实业务。
