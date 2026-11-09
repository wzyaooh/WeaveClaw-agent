# WeaveClaw 创作 Agent

本项目是 WeaveClaw 的独立关联项目。当前阶段提供 Pi 轮次适配和本地传输原型，并构建供 Electron utilityProcess 使用的 `dist/orchestrator.cjs`。主仓库已接入宿主模型调用和业务操作；Pi 接收限长请求与文本历史，但尚未使用真实工具参数和结果组织创作流程。安装后的桌面端到端验收尚未完成。

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

当前使用 Pi Agent Core 1.5.0；在 WeaveClaw 锁定的 Electron 38.8.6（Node 22.22.0）下完成过上述模拟验证。Python 宿主负责完整工具批次校验及实际写操作控制；Pi 目前仅参与控制流程。

打包脚本校验依赖清单和许可证，并生成单文件产物；安装后实际桌面运行仍需验收。

2026-11-09 本机 Electron 门禁输出（本次上下文协议变更前的历史记录，不代表新协议已通过 Electron 验证）：

```json
{"ok":true,"node":"22.22.0","checks":["single_write","complete_before_tool","multiple_writes_blocked","truncated_response_blocked","cancelled_during_stream","host_owned_turn"],"electron":"38.8.6"}
{"ok":true,"electron":"38.8.6","checks":["local_socket","host_owned_write"]}
{"ok":true,"checks":["invalid_start","early_stop","unsafe_environment","disconnect_reported","stop_during_handshake"]}
```


与 WeaveClaw 主仓库开发环境联调（主仓库必须包含支持 `turn.start` 中 `prompt` 和 `history` 的本地上下文协议的提交，且打包清单固定到本关联项目提交；需要该仓库的 Python 依赖；使用模拟模型和业务写入，不调用真实模型）：

```powershell
E:\WeaveClaw\.venv\Scripts\python.exe test/python-host-gate.py
$env:WEAVECLAW_TEST_ELECTRON = 'E:\WeaveClaw\desktop\node_modules\electron\dist\electron.exe'
E:\WeaveClaw\.venv\Scripts\python.exe test/python-host-gate.py
```

此验证分别通过独立 Node 进程和 Electron utilityProcess 的单文件产物，使用真实本地 WebSocket 连接 Python 协议、认证及宿主编排原型；尚不验证 Electron 打包或真实业务流程。Electron 测试使用合成令牌并通过父进程传递给子进程。Python 导入时可能生成本地 `runtime/` 日志目录，该目录不纳入版本控制。

## Electron 进程入口

构建产物 `dist/orchestrator.cjs` 由 Electron `utilityProcess.fork` 启动。父进程必须显式提供精简环境：Windows 只能传 `{ SystemRoot }`，其他平台传 `{}`；入口会拒绝任何其他环境键。不得继承 `WEAVECLAW_*`、模型密钥、`NODE_OPTIONS` 或其他凭据。仅通过 `parentPort` 发送 `{type: "start", url, token}` 和 `{type: "stop"}`，其中 token 是每次启动单独生成的本地编排令牌。子进程回复 `{type: "ready"}` 或 `{type: "error", code}`；收到 `ready` 后也可能因断线收到 `error`。错误码为 `unsafe_environment`、`invalid_message`、`invalid_start`、`already_started`、`connection_failed`、`host_disconnected`、`protocol_error`、`internal_error`。正常停止以 0 退出，启动失败或连接意外断开以 1 退出。令牌不得写入 URL、日志或前端。

`npm run build` 对依赖输入和环境读取执行构建检查。主项目安装包已纳入单文件产物及许可声明；还需验证安装后的完整生命周期和真实业务。

宿主在本地连接中向 Pi 提供限长的当前请求和文本历史。当前模型调用仍使用宿主自有上下文，Pi 暂不接收真实工具参数和结果，因此这只是上下文接入的第一步，不代表完整的 Pi 创作规划。

本地协议的 `turn.start` payload 必须恰好包含 `prompt`、`history` 和 `tools`。`prompt` 必须非空且最多 24000 个 Unicode 码点；`history` 最多 40 条、文本合计最多 48000 个码点，每条只能含非空 `content` 和 `role`（`user` 或 `assistant`）。宿主需过滤 system、工具和空文本历史，按同样规则截断。旧 `{tools}` 帧不受支持；协议违规会关闭整条连接并中止其余并发轮次。模型与工具参数、结果仍由宿主控制。
