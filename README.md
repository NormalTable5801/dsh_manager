<p align="center">
  <code>dsh_manager</code>
</p>

<p align="center">
  <strong>针对 DeepSeek Harness 的本地 Web 管理界面 ——</strong>
  一键托管 dsh web、检测/升级、版本回滚、数据备份还原、诊断 Doctor 与命令控制台，一个页面全搞定。
</p>

<p align="center">
  <code>零依赖</code> · <code>仅 127.0.0.1</code> · <code>UTF-8 / GBK 兼容</code> · <code>对话数据与源码分离</code> · <code>移植 dsh-doctor(BSD-3)</code> · <code>pnpm 工作区一键部署</code>
</p>

<p align="center">
  <a href="#功能总览">功能总览</a> ·
  <a href="#运行链路">运行链路</a> ·
  <a href="#pnpm-部署方式">pnpm 部署方式</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#关键约定">关键约定</a> ·
  <a href="#安全说明">安全说明</a> ·
  <a href="#开发与构建">开发与构建</a> ·
  <a href="#许可与致谢">许可与致谢</a>
</p>

无需 `npm install`、无需构建、无任何第三方运行时依赖：直接 `node server.js` 或双击 `start.bat`
即可跑起来一个管理 DeepSeek Harness 的本地界面。

> [!CAUTION]
> `dsh_manager` 是**本机自用工具**，默认只绑定 `127.0.0.1`，请勿改绑 `0.0.0.0` 或暴露到公网。
> 它可能读取/备份你的真实数据目录 `~/.dsh`（含对话与凭据），**请勿**把 `backups/`、`logs/`、`config.json`、`.env`
> 加入版本控制（`.gitignore` 已默认忽略）。

## 功能总览

| 场景 | 能力 |
| --- | --- |
| 一键启动 web | 托管 dsh web 子进程：启动 / 停止 / 重启、实时日志、识别访问地址、探活端口、防重复启动 |
| 更新升级 | 从官方仓库 `git fetch` 拉取 tag、对比 semver、提示可升级版本；升级前自动备份 `~/.dsh` |
| 版本回滚 | 拉取官方 git tags，一键切换到任意历史版本（`git checkout` + 重新构建） |
| 数据备份 | 把 `~/.dsh` 备份到 `backups/`，可还原 / 删除 / 覆盖，保留上限管理；还原前默认安全性备份 |
| 诊断 Doctor | 移植自 `dsh-doctor`（BSD-3-Clause）的 17 项检查，flutter-doctor 风格，Windows 适配 |
| 命令控制台 | 页面内执行 `dsh xxx`，输出经 SSE 实时回显（白名单 + argv 传入，不经 shell） |
| 环境检查 | 检测 node / pnpm / git 版本，校验 node 是否满足 Harness 要求 |
| 一键构建 | 在仓库内执行 `pnpm install` + `pnpm build`，产出 CLI 与 web 前端 |

> [!TIP]
> 排查疑难时优先走「诊断 Doctor」跑一遍完整检查，再在「控制台 Console」里执行 `dsh doctor`、`dsh --help`
> 等命令看细节——两者覆盖安装级与环境运行级两个层面。

## 运行链路

`dsh_manager` 只做「托管与调度」，不参与 dsh 的内部实现。它与你机器上的两个东西协作：

```text
  你 (浏览器 127.0.0.1:8730)
            │  1) 启动 / 停止 / 重启 / 实时日志
            ▼
   ┌─────────────────────────────┐
   │         dsh_manager         │   <─ 本仓库（独立 git 仓库）
   │   server.js + doctor.js     │   只读/受控操作，不改 Harness 源码
   └─────────────────────────────┘
        │                 │            │
        │ git/pnpm/build↘ │ node↘      │ robocopy 备份/还原↘
        ▼                 ▼            ▼
   Harness 源码仓库       dsh web      ~/.dsh 数据目录
   (apps/cli/lib/bin.js)  (子进程)     (对话+插件+凭据+设置)
```

- **Harness 源码仓库**与 `dsh_manager` 是**两个独立的 git 仓库**（源码在兄弟目录，如 `D:\dsh\deepseek-harness-dsh-v0.1.1-rc.2`）。
- 升级 / 回滚只改源码版本并重新构建，**永不触碰** `~/.dsh`；所有交互数据都在 `~/.dsh`，因此切换版本不影响你的对话与配置。

## pnpm 部署方式

`dsh_manager` 托管的是 DeepSeek Harness —— 一个 **pnpm workspace 单仓（monorepo）**。
「装依赖 → 构建 → 起 web」整条链路都依赖 pnpm，这正是本工具"**一键部署**"的底层逻辑：

```bash
cd D:\dsh\deepseek-harness-dsh-v0.1.1-rc.2
pnpm install       # 装齐各 workspace 依赖
pnpm build         # 产出 apps/cli/lib/bin.js 与 apps/web/dist
pnpm dsh web       # 运行仓库内定义的 dsh script，启动内置 web
```

对照到界面上：

- 「**构建**」＝ 在仓库内执行 `pnpm install` + `pnpm run build`，生成 CLI 入口与 web 前端产物。
- 「**启动 dsh web**」＝ 读取构建产物 `apps/cli/lib/bin.js` 启动；它等价于 `pnpm dsh web` 最终落到的命令（只是直连 node，省去 pnpm shim 的间接开销）。
- 也可在「设置」切到 `source` 模式，用 `node --import tsx/esm apps/cli/src/bin.ts` 直接跑 tsx 源码，适合开发调试。
- `apps/cli`（CLI）与 `apps/web`（内置 web）位于同一工作区，依赖复用、命令统一，无需额外安装——这是"零依赖 dsh_manager"之外的另一种"零额外部署"。

## 快速开始

1. 确保本机 `node` 满足 `^22.19.x` 或 `24.x`，且已安装 `pnpm` 与 `git`。
2. 双击 `start.bat`（或 `node server.js`），窗口会自动打开 `http://127.0.0.1:8730`。
3. 在「环境检查」为仓库配置官方 remote（或直接点「拉取版本列表」）；先「构建」一次生成 `apps/cli/lib/bin.js` 与 web 前端产物。
4. 回到「启动 web」点「启动 dsh web」，即可打开 dsh 界面。

> 若点击 `start.bat` 后窗口一闪而过（而非停留在服务运行态），说明启动失败——多为端口被占用或 node 版本不符，按 Ctrl+C / 查看窗口报错即可。

## 关键约定

- **数据与代码隔离**：对话、插件配置、凭据都在 `~/.dsh`，与源码仓库分离；升级 / 回滚不影响数据。
- **诚实原则修复**：Diagnostic 的修复只做声明为安全、可回滚的进程内动作——settings 缺失/损坏先备份再重建；凭据手动输入后写入 `~/.dsh/.env`；其余只给指引，不越权改动。
- **破坏性操作二次确认**：回滚、覆盖还原、删除备份均需弹窗确认。
- **控制台白名单**：只接受 `dsh` 开头的命令，参数直接作为 argv 传入，不经过 shell，规避 `rm -rf /` 这类注入。

## 安全说明

- 服务仅绑定 `127.0.0.1`；所有命令均由内部固定命令 + 严格校验过的参数拼接，避免注入。
- `.gitignore` 已忽略 `backups/`（含真实 `~/.dsh` 数据）、`logs/`、`config.json`（本机路径）、`.env`、密钥与编辑器临时文件；**请勿 `git add -f` 强制提交**。
- 该工具用于自用，请谨慎执行还原 / 回滚 / 删除备份等动作。

## 开发与构建

`dsh_manager` 本身零依赖，开发即改即用：

```bash
cd d:\dsh\dsh_manager
node server.js            # 启动管理界面，浏览器打开 http://127.0.0.1:8730
```

- 后端：`server.js`（HTTP + REST + SSE + 子进程托管 + 控制台执行）、`doctor.js`（诊断）。
- 前端：`public/index.html`、`public/app.js`、`public/style.css`（无构建，直接生效）。
- 本目录是一个已初始化的 git 仓库；改动后按需提交即可，注意保持 `.gitignore` 生效。

## 许可与致谢

- `dsh_manager` 为自研本地工具（默认仅本机自用）。其「诊断 Doctor」移植自
  [`coppynight/dsh-doctor`](https://github.com/coppynight/dsh-doctor)（BSD-3-Clause，版权 `dsh-external`）。
  `doctor.js` 顶部标注来源、末尾保留**原版权声明 + 条款 + 免责声明全文**，以符合 BSD-3 第 1 条源码再分发要求。
- 管理对象为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness.git)。