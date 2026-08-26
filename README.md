# dsh_manager

针对 DeepSeek Harness（DSH）的本地 Web 管理界面。**零依赖、开箱即用**；无需 `npm install`，
直接 `node server.js` 或双击 `start.bat` 即可。默认只监听 `127.0.0.1`，不对外网开放。

> 本仓库（`dsh_manager`）与 Harness 源码仓库是**两个独立的 git 仓库**。
> Harness 源码位于 `dsh_manager` 的兄弟目录（如 `D:\dsh\deepseek-harness-dsh-v0.1.1-rc.2`）；
> `dsh_manager` 只对它做"调用 / 构建 / 切换版本"等只读或受控操作，**不会改动 Harness 的源码与提交**。

## 主要功能

| 能力 | 说明 |
|------|------|
| 一键启动 dsh web | 托管 dsh web 子进程：启动 / 停止 / 重启、实时日志、识别访问地址、探活端口、防止重复启动 |
| 检测更新 + 升级 | 从官方仓库 `git fetch` 拉取 tag，对比 semver 提示可升级版本；升级前**自动备份 `~/.dsh`** |
| 版本列表 + 回滚 | 拉取官方 git tags，一键切换到任意历史版本（`git checkout` + 重新构建） |
| 数据备份 / 还原 | 把 `~/.dsh`（对话 + 插件配置 + 凭据 + 设置）备份到 `dsh_manager/backups`；可还原、删除、覆盖；保留上限管理 |
| 环境检查 | 检测 node / pnpm / git 及版本，校验 node 是否满足 Harness 要求（`^22.19.x` 或 `24.x`） |
| 诊断 Doctor | 移植自 `dsh-doctor`（BSD-3-Clause）的 17 项检查，flutter-doctor 风格；安装级 + harness 级；"诚实原则"修复 |
| 控制台 Console | 在页面内执行 `dsh xxx` 命令，输出实时流式回显（白名单、argv 传参，不经 shell） |
| 构建 | 在仓库内执行 `pnpm install` + `pnpm build` |
| 危险操作二次确认 | 回滚、覆盖还原、删除备份均需弹窗确认 |

## 目录结构

```
dsh_manager/
├── server.js          # 零依赖 Node 服务（HTTP + REST + SSE + 子进程托管 + 控制台执行）
├── doctor.js          # 诊断检查 + 安全修复（移植自 dsh-doctor，Windows 适配）
├── config.json        # 运行配置（自动生成、含本机路径，故已 gitignore；缺失时用默认值自建）
├── start.bat          # Windows 双击启动（UTF-8 + chcp 65001，前端 node 前台运行便于 Ctrl+C）
├── public/            # WebUI（index.html / app.js / style.css）
├── backups/           # ~/.dsh 备份存放处（自动生成，已 gitignore）
├── logs/              # 任务日志（自动生成，已 gitignore）
└── .gitignore         # 保护 backups / logs / 凭据等敏感数据不上传
```

## 使用步骤

1. 双击 `start.bat`（或 `node server.js`），窗口会自动打开 `http://127.0.0.1:8730`。
2. 若仓库未配置官方 remote：进入「环境检查」→「添加官方 remote」，或直接点「拉取版本列表」。
3. 先「构建」一次生成 `apps/cli/lib/bin.js` 与 web 前端产物，再「启动 dsh web」。
4. 需要排查时：进「诊断 Doctor」运行全部检查；在「控制台 Console」里 `dsh doctor`、`dsh --help` 等随意执行。

### 控制台 Console 说明

- 只接受 `dsh` 开头的命令，例如 `dsh doctor`、`dsh --help`、`dsh web`。
- 在仓库目录下以 `node apps\cli\lib\bin.js <参数>` 执行（含 `launchMode=source` 时走 tsx 源码）。
- 参数**不经 shell**，直接作为 argv 传入，规避 `rm -rf /` 这类注入；一次只允许一条命令运行。
- 输出经 SSE 实时回显；可随时「停止」（taskkill 整棵进程树）。

## 关键约定

- **升级 / 回滚**：只切换源码版本并重新构建，**不触碰** `~/.dsh`。对话、插件配置、凭据都在 `~/.dsh`，与源码分离，因此升级源码不影响你的数据。
- **自动备份**：升级 / 回滚前默认把当前 `~/.dsh` 备份到 `backups/`（可在设置关闭）。
- **还原数据**：还原会用备份覆盖当前 `~/.dsh`，默认先对当前数据做一次安全性备份。
- **源码改动保护**：切换版本前若检测到仓库存在已跟踪的未提交改动，会中止并提示。

## 安全说明

- 服务仅绑定 `127.0.0.1`，不对外网开放。
- 所有命令（git / pnpm / robocopy / node）均由内部固定命令 + 严格校验过的参数拼接，输入（tag、备份 id 等）均已校验，避免注入。
- 控制台命令限定 `dsh` 前缀并以 argv 传入，同样不经过 shell。
- **`.gitignore` 已保护 `backups/`（含真实 `~/.dsh` 数据）、`logs/`、`config.json`（本机路径）、`.env`、密钥等**，请勿 `git add -f` 强行提交这些文件。
- 该工具用于自用管理本机 Harness，请谨慎操作还原 / 回滚 / 删除备份等破坏性动作。

## 常见问题

- **端口被占用**：manager 会自动换用下一个端口。dsh web 端口在「设置」里配 `webPort`（0 = 自动）。
- **node 版本不够**：Harness 要求 `node ^22.19.x` 或 `24.x`，版本不足会导致构建失败，环境检查页会有告警。
- **拉取不到版本**：请确认网络可访问 GitHub，且仓库已配置官方 remote。
- **启动后窗口空 / 无浏览器弹出**：确认 `server.js` 是否正在监听，Ctrl+C 应能干净退出。