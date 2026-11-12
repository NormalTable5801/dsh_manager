> [!WARNING]
> **本仓库已于 2026-11-12 归档（Archived），不再维护。**
> 下面列出归档原因、当前更合适的替代方案，以及继续使用本仓库时需要注意的已知问题。

## 为什么归档
本项目在早期Traffic中可见有少量使用者，之后仅零星clone；

同时DeepSeek Harness 生态补齐了本项目原本承担的绝大部分工作：

| 本项目原本做的事 | 现在更合适的做法 |
| --- | --- |
| 一键安装 / 更新 Harness、托管 dsh web 启停 | [官方桌面版](https://www.deepseek.com/harness/)（2026 年 9 月底发布）：安装包直接装，自带 Electron 壳与 Node/pnpm 运行时，自动更新、托盘、后台任务，不需要本机 Node |
| 依赖检测 / 新人引导 | 同上。官方桌面版没有 Node 前置依赖，这一层需求随之消失 |
| 插件 profile 组合包开关 | 官方 Web 插件页 + 「发现」页（支持自定义插件索引源）；社区还有 dsh-market、DSH Plugin Store、dsh.so 等多家插件市场 |
| `~/.dsh` 备份 / 还原 | `dsh-vault`（加密备份到私有 GitHub 仓库、一键跨机还原）、`dsh-backup`（定时 tgz + 轮转）等插件；部分桌面客户端在「设置 → 备份」里也提供 |
| Doctor 深度诊断 | 上游 [`dsh-doctor`](https://github.com/moonquake2004/dsh-doctor) 仍在持续迭代（含 `--security`），并已有 `dsh-selfrepair` 做修复与回滚；官方桌面版自带故障恢复对话框与崩溃报告 |


没有被完全覆盖只有两件事：**dsh 历史版本回滚**（官方把桌面壳与 dsh 版本锁死、只向前）和**整库备份 / 还原的图形化面板**。前者已有替代实现（hermes-web-ui 的 Studio 集成提供精确版本 pin 与 restore），后者已被上述备份插件接手。因此本项目不再有独立的维护价值。

## 不建议继续使用本仓库。


代码仍可 `git clone` 后 `node server.js` 运行，但请注意以下**已确认且不再修复**的问题（上游在本项目停止跟进后已发生变更）：

- **Node 版本约束过时**：`server.js` 中硬编码 `node ^22.19.x（或 24.x）`，而上游自 0.2.2 起外部运行最低要求 Node 24.9。
- **发布渠道过时**：仅识别 `latest / next / alpha`，与实际发布渠道已有偏差。
- **端口探活写死 3080**：较新的官方与社区桌面端普遍改用随机端口，探活可能误判。
- **控制台示例命令无效**：README 与控制台示例中的 `dsh doctor` 在官方 CLI 中并不存在（`doctor` 是社区 `dsh-doctor` 包/插件的命令）。
- **插件管理存在退化路径**：`plugins.js` 的 `addProfilePluginDirect` / `removeProfilePluginDirect` 只修改 `package.json`、不执行 `pnpm install`，会留下「依赖已声明、`node_modules` 未安装、bundle patch 未生成」的半安装状态，且绕过官方的兼容性校验与 profile 写锁。**不建议用它管理新版 profile 的插件。**

此外请如果还要使用继续遵守原有安全前提：本工具读取并备份真实的 `~/.dsh`（含对话、插件配置与凭据），备份产物不要入库、不要上传、不要分享；服务只应绑定 `127.0.0.1`。

## 许可与致谢（不变）

- 本项目以 **BSD-3-Clause** 发布（版权 `NormalTable5801`，2026），完整条款见 [`LICENSE`](LICENSE)。归档不改变既有授权。
- `doctor.js` 的诊断引擎改写自 [`moonquake2004/dsh-doctor`](https://github.com/moonquake2004/dsh-doctor)（MIT License，版权 `moonquake2004`）。按 MIT 要求，`doctor.js` 顶部的来源标注与末尾的许可证全文**必须保留**，即使仓库归档。
- DSH 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的缩写。本项目为独立第三方项目，与 DeepSeek 无隶属、合作、背书或授权关系。
