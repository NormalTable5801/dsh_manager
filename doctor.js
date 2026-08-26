/* =====================================================================
 * dsh_manager / doctor.js
 * flutter-doctor 风格的 Harness 诊断与安全修复。
 * 移植自 dsh-doctor 项目（BSD-3-Clause），并按 dsh_manager 的实际形态
 * 做了 Windows 适配：
 *   - 保留适用于“git 源码方式管理 + Windows”的检查（node/git/pnpm/
 *     credentials/settings/sessions/web-log/…）；
 *   - 依赖 Unix 安装布局的检查（privilege/ownership/layout/staging/path/
 *     hooks/lefthook）显式判定为“跳过（本环境不适用）”而非静默误报。
 * 零依赖，仅用 Node 内置模块。
 * ===================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

/* ------------------------------- 工具 ------------------------------- */

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, shell: true });
  return { status: r.status ?? (r.error ? 127 : -1), stdout: r.stdout || "", stderr: r.stderr || "" };
}
function parseVersion(s) {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(s || "").trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] || 0) };
}
function isSupportedNode(versionStr) {
  const v = parseVersion(versionStr);
  if (!v) return false;
  return v.major >= 24 || (v.major === 22 && v.minor >= 19);
}
function parseGitVersion(out) {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(String(out || ""));
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
}
function atLeast(actual, min) {
  for (let i = 0; i < min.length; i++) {
    const a = actual[i] || 0;
    if (a > min[i]) return true;
    if (a < min[i]) return false;
  }
  return true;
}
function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
function dirWritable(p) { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; } }
function readFileSafe(p, maxBytes) {
  try {
    const buf = fs.readFileSync(p);
    return maxBytes && buf.length > maxBytes ? buf.subarray(0, maxBytes).toString("utf8") : buf.toString("utf8");
  } catch { return undefined; }
}
const IS_UNIX_LAYOUT = "该检查依赖 Unix 安装布局；dsh_manager 以 git 源码 + Windows 方式管理，不适用，跳过。";

/* ------------------------------- 诊断上下文 ------------------------------- */

function buildContext(opts) {
  const dshHome = opts.dshHome;
  const envFile = path.join(dshHome, ".env");
  const webLogFile = locateWebLog(dshHome);
  const ctx = {
    ...opts,
    envFile,
    envKeyLines: readFileSafe(envFile, 64 * 1024)?.split(/\r?\n/) ?? [],
    settingsText: readFileSafe(path.join(dshHome, "settings.yaml"), 64 * 1024),
    sessionsWritable: exists(path.join(dshHome, "sessions")) ? dirWritable(path.join(dshHome, "sessions")) : null,
    repoGitWritable: (opts.repoPath && exists(path.join(opts.repoPath, ".git"))) ? dirWritable(path.join(opts.repoPath, ".git")) : null,
    webLogFile,
    webLogText: webLogFile ? readFileSafe(webLogFile, 512 * 1024) : undefined,
    webLogMtime: webLogFile ? (fs.statSync(webLogFile).mtimeMs || 0) : 0,
    cordisText: readFileSafe(path.join(dshHome, "cordis.patch.yml"), 64 * 1024),
    _run: run,
  };
  return ctx;
}
function locateWebLog(dshHome) {
  for (const p of [path.join(dshHome, "logs", "web.log"), path.join(dshHome, "web.log")]) {
    if (exists(p)) return p;
  }
  return undefined;
}

/* ------------------------------- 检查定义 ------------------------------- */

const CHECKS = [
  {
    id: "node", level: "install", title: "Node 版本",
    run(c) {
      if (!isSupportedNode(c.processVersion)) {
        return { severity: "error", message: `Node ${c.processVersion} 不受支持；dsh 需要 ^22.19.0 || >=24.0.0`, remediation: "升级 Node 到 22.19+ 或 24.x，然后重新运行诊断" };
      }
      return { severity: "ok", message: `Node ${c.processVersion} 满足要求（^22.19.0 || >=24.0.0）` };
    },
  },
  {
    id: "git", level: "install", title: "git",
    run(c) {
      const r = c._run("git", ["--version"]);
      if (r.status !== 0) return { severity: "error", message: "未在 PATH 找到 git", remediation: "安装 git 后重试" };
      const nums = parseGitVersion(r.stdout);
      if (!nums) return { severity: "warn", message: `无法解析 git 版本：${r.stdout.trim()}`, remediation: "请升级到 git 2.26 或更高" };
      if (!atLeast(nums, [2, 26, 0])) return { severity: "warn", message: `${r.stdout.trim()} 低于 worktree hooks 所需 2.26`, remediation: "升级 git 到 2.26+ 后重试" };
      return { severity: "ok", message: r.stdout.trim() };
    },
  },
  {
    id: "pnpm", level: "install", title: "pnpm",
    run(c) {
      const r = c._run("pnpm", ["--version"]);
      if (r.status !== 0) return { severity: "warn", message: "未在 PATH 找到 pnpm（构建/升级需要）", remediation: "安装 pnpm：npm i -g pnpm，或见官方 https://pnpm.io/installation" };
      const v = (r.stdout.match(/^\d+\.\d+\.\d+/) || [r.stdout.trim()])[0];
      return { severity: "ok", message: `pnpm ${v}` };
    },
  },
  {
    id: "credentials", level: "install", title: "凭据 DEEPSEEK_API_KEY",
    run(c) {
      const has = c.envKeyLines.some((l) => /^\s*DEEPSEEK_API_KEY\s*=/.test(l));
      if (!has) return { severity: "warn", message: `${c.envFile} 未设置 DEEPSEEK_API_KEY`, remediation: "在“诊断”页用“修复凭据”补写，或手动写入该 .env 后重启 dsh" };
      return { severity: "ok", message: `DEEPSEEK_API_KEY 已在 ${c.envFile} 配置` };
    },
  },
  {
    id: "settings", level: "harness", title: "配置 settings.yaml",
    run(c) {
      const file = path.join(c.dshHome, "settings.yaml");
      if (c.settingsText === undefined) return { severity: "warn", message: `${file} 不存在——当前使用默认配置`, remediation: "在“诊断”页点击“修复设置”可写入最小合法配置" };
      if (c.settingsText.trim().length === 0) return { severity: "error", message: `${file} 为空——空配置可能拖垮 web 启动`, remediation: "在“诊断”页点击“修复设置”（自动备份并重建）" };
      return { severity: "ok", message: `${file} 存在且非空（${c.settingsText.length} 字节）` };
    },
  },
  {
    id: "sessions", level: "harness", title: "会话存储 sessions",
    run(c) {
      const dir = path.join(c.dshHome, "sessions");
      if (!exists(dir)) return { severity: "ok", message: "尚无会话存储——首次会话会自动创建" };
      if (c.sessionsWritable === false) return { severity: "error", message: `会话目录 ${dir} 不可写`, remediation: "检查目录权限，或以有权限的账户重启 dsh_manager" };
      let n = 0; try { n = fs.readdirSync(dir).length; } catch {}
      return { severity: "ok", message: `会话存储可写（${n} 个顶层条目）` };
    },
  },
  {
    id: "credentials-chain", level: "harness", title: "凭据来源链",
    run(c) {
      const layers = [];
      if (process.env.DEEPSEEK_API_KEY) layers.push("进程环境");
      if (c.envKeyLines.some((l) => /^\s*DEEPSEEK_API_KEY\s*=/.test(l))) layers.push(`$DSH_HOME/.env（${c.envFile}）`);
      if (layers.length === 0) return { severity: "warn", message: "没有任何一层提供 DEEPSEEK_API_KEY（进程环境 → $DSH_HOME/.env）", remediation: "在“诊断”页补写 $DSH_HOME/.env，或设置环境变量后重启" };
      return { severity: "ok", message: `DEEPSEEK_API_KEY 由 ${layers.join("、")} 提供（不显示值）` };
    },
  },
  {
    id: "web-log", level: "harness", title: "web 日志",
    run(c) {
      if (!c.webLogFile) return { severity: "ok", message: "暂无 web.log —— dsh web 尚未写日志" };
      const lines = String(c.webLogText || "").split(/\r?\n/);
      const errors = lines.filter((l) => /ERROR|failed to load|ERR_[A-Z]|error:/i.test(l));
      if (errors.length === 0) {
        const age = Math.round((Date.now() - c.webLogMtime) / 60000);
        return { severity: "ok", message: `${c.webLogFile} 无错误行（上次写入 ${age} 分钟前）` };
      }
      const last = errors[errors.length - 1].trim().slice(0, 200);
      return { severity: "warn", message: `${c.webLogFile} 含 ${errors.length} 行错误；最近：${last}`, remediation: "查看完整日志，修复根因后重启 dsh web", detail: errors.slice(-5).join("\n") };
    },
  },
  {
    id: "repository-plugins", level: "harness", title: "repository 插件",
    run(c) {
      if (c.cordisText === undefined) return { severity: "ok", message: "无 cordis.patch.yml —— 未声明 repository 插件" };
      const repoLines = String(c.cordisText).split(/\r?\n/)
        .filter((l) => /^\s*-\s*['"]?github:/.test(l))
        .map((l) => l.trim().replace(/^-\s*['"]?/, "").replace(/['"]\s*$/, ""));
      if (repoLines.length === 0) return { severity: "ok", message: "已存在 cordis.patch.yml，但未发现 github: repository 安装行" };
      const bad = repoLines.filter((l) => !/^github:[^/\s]+\/[^#\s]+#[0-9a-f]{7,40}&path:\/[^\s]+$/.test(l));
      if (bad.length) return { severity: "warn", message: `repository 源格式异常：${bad.join("、")}`, remediation: "期望 `github:<owner>/<repo>#<commit>&path:/<path>`，请修正 cordis.patch.yml" };
      return { severity: "ok", message: `声明的 repository 源格式合法（${repoLines.length} 条）：${repoLines.map((s) => s.split("#")[0]).join("、")}` };
    },
  },
  {
    id: "install-layout", level: "install", title: "安装布局",
    run() { return { severity: "ok", message: IS_UNIX_LAYOUT }; },
  },
  {
    id: "staging-leftovers", level: "install", title: "staging 残留",
    run() { return { severity: "ok", message: IS_UNIX_LAYOUT }; },
  },
  {
    id: "path", level: "install", title: "PATH 中的 bin 目录",
    run() { return { severity: "ok", message: IS_UNIX_LAYOUT }; },
  },
  {
    id: "ownership", level: "install", title: "数据目录可写",
    run(c) {
      if (!exists(c.dshHome)) return { severity: "ok", message: "数据目录尚不存在" };
      if (!dirWritable(c.dshHome)) return { severity: "error", message: `数据目录 ${c.dshHome} 不可写`, remediation: "检查目录权限，或以有权限账户重启 dsh_manager" };
      // Windows 下 uid 恒为 0，无法沿用 POSIX 属主判定（dsh-doctor 已知误报），改为校验可写性
      return { severity: "ok", message: `数据目录可写（${c.dshHome}）；Windows 下不评估 POSIX 属主` };
    },
  },
  {
    id: "privilege", level: "install", title: "非 root 运行",
    run() {
      if (typeof process.getuid === "function" && process.getuid() === 0) {
        return { severity: "error", message: "dsh 以 root(uid 0) 运行", remediation: "以普通用户身份运行，切勿使用 sudo" };
      }
      return { severity: "ok", message: "以普通用户运行（Windows 无 uid 判定）" };
    },
  },
  {
    id: "hooks-path", level: "install", title: "git hooks",
    run(c) {
      const r = c._run("git", ["config", "--global", "--get", "core.hooksPath"]);
      if (r.status === 0 && r.stdout.trim()) return { severity: "warn", message: `存在用户级全局 git core.hooksPath：${r.stdout.trim()}`, remediation: "若已废弃可 `git config --global --unset core.hooksPath`" };
      return { severity: "ok", message: "无用户级全局 core.hooksPath" };
    },
  },
  {
    id: "repository-git-state", level: "install", title: "仓库 git 状态可写",
    run(c) {
      if (!c.repoPath || !exists(path.join(c.repoPath, ".git"))) return { severity: "ok", message: "仓库不在 git 管理下（或路径未配置）" };
      if (c.repoGitWritable === false) return { severity: "error", message: `仓库 .git 目录不可写：${path.join(c.repoPath, ".git")}`, remediation: "检查仓库目录写权限（可能是 sudo 安装残留导致属主异常）" };
      return { severity: "ok", message: "仓库 .git 可写" };
    },
  },
  {
    id: "plugins", level: "harness", title: "插件挂载状态",
    run(c) {
      if (c.webLogFile && c.webLogText && /plugin tree failed to load|failed to load|ERR_PLUGIN/i.test(c.webLogText)) {
        return { severity: "warn", message: "web 日志出现插件加载失败迹象", remediation: "查看完整日志，修复插件配置后重启 dsh", detail: c.webLogText.split(/\r?\n/).filter((l) => /plugin tree failed to load|failed to load|ERR_PLUGIN/i.test(l)).slice(-5).join("\n") };
      }
      return { severity: "ok", message: "未从 web 日志发现插件加载失败迹象（精确挂载状态需在会话内查看）" };
    },
  },
];

/* ------------------------------- 报告 ------------------------------- */

function buildReport(ctx, only) {
  const findings = [];
  const selected = only && only.length ? CHECKS.filter((c) => only.includes(c.id)) : CHECKS;
  for (const check of selected) {
    let result;
    try { result = check.run(ctx); } catch (e) { result = { severity: "error", message: `检查异常：${e.message}` }; }
    for (const f of (Array.isArray(result) ? result : [result])) {
      findings.push({ checkId: check.id, title: check.title, level: check.level, severity: f.severity, message: f.message, remediation: f.remediation, detail: f.detail });
    }
  }
  const summary = { ok: 0, warn: 0, error: 0 };
  for (const f of findings) if (summary[f.severity] !== undefined) summary[f.severity] += 1;
  // 用 healthy 表示“所有检查通过”；避免占用响应体运输层 ok 字段，防止与前端 api() 判错冲突
  return { version: "port-of-dsh-doctor-v0.1.0", findings, summary, healthy: summary.error === 0 };
}

/* ------------------------------- 修复 ------------------------------- */

const MINIMAL_SETTINGS = "# dsh settings (restored by dsh_manager doctor)\n{}\n";
function fixSettings(dshHome) {
  const settingsFile = path.join(dshHome, "settings.yaml");
  fs.mkdirSync(dshHome, { recursive: true });
  const content = exists(settingsFile) ? readFileSafe(settingsFile) : undefined;
  if (content !== undefined && content.trim().length > 0) {
    return { action: "settings-restore", applied: false, message: `${settingsFile} 非空，无需修复` };
  }
  if (content !== undefined) {
    const backup = settingsFile + ".doctor-bak";
    try { fs.copyFileSync(settingsFile, backup); } catch {}
    fs.writeFileSync(settingsFile, MINIMAL_SETTINGS, "utf8");
    return { action: "settings-restore", applied: true, message: `已备份损坏文档到 ${backup} 并写入最小合法配置` };
  }
  fs.writeFileSync(settingsFile, MINIMAL_SETTINGS, "utf8");
  return { action: "settings-restore", applied: true, message: `已创建最小合法 ${settingsFile}` };
}
/** 向 $DSH_HOME/.env 写入 DEEPSEEK_API_KEY（去重、值不回显）。
 * Windows 无 chmod 语义，仅尽最大努力置 0600。 */
function fixCredentials(dshHome, value) {
  const envFile = path.join(dshHome, ".env");
  const key = String(value || "").trim();
  if (!key) return { action: "credentials-write", applied: false, message: "未提供 key —— 已跳过" };
  fs.mkdirSync(dshHome, { recursive: true });
  let existing = "";
  try { existing = fs.readFileSync(envFile, "utf8"); } catch {}
  const lines = existing.split(/\r?\n/).filter((l) => l.trim() !== "" && !/^\s*DEEPSEEK_API_KEY\s*=/.test(l));
  lines.push(`DEEPSEEK_API_KEY=${key}`);
  fs.writeFileSync(envFile, lines.join("\n") + "\n", "utf8");
  try { fs.chmodSync(envFile, 0o600); } catch {}
  return { action: "credentials-write", applied: true, message: `已将 DEEPSEEK_API_KEY 写入 ${envFile}（值不回显）` };
}

module.exports = { run, buildReport, buildContext, fixSettings, fixCredentials, CHECKS };