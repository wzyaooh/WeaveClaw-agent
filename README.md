# WeaveClaw 创作 Agent

本项目是 WeaveClaw 的独立关联项目。当前阶段只验证 Pi 在 Electron utilityProcess 中的运行与工具执行边界，尚未接入 WeaveClaw 的模型、任务或项目数据。

安装依赖并运行不调用真实模型的验证：

```powershell
npm ci --ignore-scripts
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
{"ok":true,"node":"22.22.0","checks":["single_write","complete_before_tool","multiple_writes_blocked","truncated_response_blocked","cancelled_during_stream"],"electron":"38.8.6"}
```
