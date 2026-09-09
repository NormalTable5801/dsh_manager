/* =====================================================================
 * dsh_manager  server.js
 * 零依赖 Node 服务：为 DeepSeek Harness 提供 WebUI 管理界面。
 * 功能：一键启动/停止 dsh web、检测更新与升级（npm 发布流）、版本安装与回滚、
 *       ~/.dsh 数据备份 / 还原 / 覆盖、环境检测、进程托管、SSE 日志。
 * 默认仅绑定 127.0.0.1 本地监听。
 * ===================================================================== */
"use strict";

const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn, spawnSync, exec } = require("child_process");
const doctor = require("./doctor");
const plugins = require("./plugins");

/* ------------------------------- 常量 ------------------------------- */

const ROOT = __dirname;                  // dsh_manager 目录
const PUBLIC_DIR = path.join(ROOT, "public");
const CONFIG_PATH = path.join(ROOT, "config.json");
const BACKUP_DIR = path.join(ROOT, "backups");
const LOG_DIR = path.join(ROOT, "logs");

const DSH_DIR_NAME = ".dsh";
const DSHDIR_ENV = "DSH_HOME";
const INSTALL_PKG = "@deepseek-ai/dsh";
const GITHUB_OWNER = "deepseek-ai";
const GITHUB_REPO = "deepseek-harness";

const isWin = process.platform === "win32";
const NODE_NEED = "node ^22.19.x（或 24.x）";
const CHANNELS = ["latest", "next", "alpha"];

/* ------------------------------- 配置 ------------------------------- */

// 新人依赖安装指引（默认走引导式：复制命令 / 打开官方页；点“自动安装”才用 winget 半自动）。
// cmd 是可复制给用户的安装命令；url 是官方下载页。
const DEP_HELP = {
  node: { cmd: "winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements", url: "https://nodejs.org/zh-cn/download" },
};

const DEFAULT_CONFIG = {
  installDir: "",                  // 受管独立 npm 安装目录；留空 => <dsh_manager>/dsh-install
  channel: "latest",               // 检测/升级默认跟随的发布流：latest | next | alpha
  onboarded: false,                // 是否已完成首次引导（写入被 gitignore 的 config.json）
  dshHome: "",                     // 留空 => %USERPROFILE%\.dsh / $DSH_HOME
  port: 8730,
  webPort: 0,                      // >0 用于探活与识别访问地址
  launchProfile: "web",
  autoBackupBeforeUpgrade: true,
  safetyBackupBeforeRestore: true,
  maxBackups: 10,
  bindHost: "127.0.0.1",
};

let config = loadConfig();

function defaultInstallDir() {
  return path.join(ROOT, "dsh-install");
}

function loadConfig() {
  const base = { ...DEFAULT_CONFIG };
  try {
    if (fs.existsSync(CONFIG_PATH)) Object.assign(base, JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
  } catch { /* ignore */ }
  base.installDir = (base.installDir && base.installDir.trim()) ? path.resolve(expandTilde(base.installDir)) : defaultInstallDir();
  if (!CHANNELS.includes(base.channel)) base.channel = "latest";
  return base;
}
function saveConfig() {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}
function resolveDshHome() {
  if (config.dshHome && config.dshHome.trim()) return path.resolve(expandTilde(config.dshHome));
  const env = process.env[DSHDIR_ENV];
  if (env && env.trim()) return path.resolve(expandTilde(env));
  return path.join(os.homedir(), DSH_DIR_NAME);
}
function expandTilde(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/* ------------------------------- 工具 ------------------------------- */

function stripAnsi(s) { return String(s).replace(/\u001b\[[0-9;]*m/g, ""); }
function fmtBytes(n) {
  if (!isFinite(n)) return "-";
  const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${u[i]}`;
}
function safeId(s, re) { return typeof s === "string" && re.test(s) ? s : null; }
const TAG_RE = /^[A-Za-z0-9._/-]+$/;
const BACKUP_RE = /^[A-Za-z0-9._-]+$/;
const NAME_RE = /^[^\r\n;|&<>`]{1,200}$/;

function parseSemver(v) {
  v = String(v).trim().replace(/^v/i, "");
  const pre = v.split("-")[1] || "";
  const m = v.split("-")[0].split(".").map((x) => parseInt(x, 10));
  return { major: m[0] || 0, minor: m[1] || 0, patch: m[2] || 0, pre };
}
function cmpPre(a, b) {
  if (a === b) return 0;
  if (!a && b) return 1;
  if (a && !b) return -1;
  const pa = a.split("."), pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { if (+x !== +y) return +x > +y ? 1 : -1; }
    else if (nx) return 1;
    else if (ny) return -1;
    else if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}
function cmpSemver(a, b) {
  const A = parseSemver(a), B = parseSemver(b);
  if (A.major !== B.major) return A.major > B.major ? 1 : -1;
  if (A.minor !== B.minor) return A.minor > B.minor ? 1 : -1;
  if (A.patch !== B.patch) return A.patch > B.patch ? 1 : -1;
  return cmpPre(A.pre, B.pre);
}
/** 归一化版本号字符串（去掉可选的前导 v）。 */
function normVersion(v) {
  return String(v || "").replace(/^v/i, "").trim();
}

/* ------------------------------- 命令执行 ------------------------------- */

function sanitizeArg(a) {
  if (typeof a !== "string") return "";
  if (/[\r\n&|;`<>$]/.test(a)) return "";
  return a;
}
/** 运行命令并逐行回调，返回退出码（Promise）。Windows 用 shell:true 以支持 npm.cmd 等 shim。 */
function run({ cmd, args, cwd, env, onLine, label }) {
  return new Promise((resolve) => {
    const safeArgs = args.map(sanitizeArg);
    // shell:true 下 Windows 会把 cmd 与 args 裸拼接后交给 cmd.exe 解析，
    // 若 cmd 本身是含空格的可执行文件路径（如 C:\Program Files\nodejs\node.exe）
    // 不加引号会被截断成「C:\Program…」导致启动失败，这里统一补上引号。
    const quotedCmd = /\s/.test(cmd) ? `"${cmd}"` : cmd;
    const child = spawn(quotedCmd, safeArgs, {
      cwd, env: { ...process.env, ...env }, shell: true, windowsHide: true,
    });
    const emit = (buf) => String(buf).split(/\r?\n/).forEach((line) => {
      let l = stripAnsi(line);
      if (l) l = l.replace(/\s+$/g, "");
      if (l) onLine && onLine(l);
    });
    child.stdout.on("data", emit);
    child.stderr.on("data", emit);
    child.on("error", (e) => { onLine && onLine(`[${label || cmd}] 无法启动: ${e.message}`); resolve(127); });
    child.on("close", (code) => resolve(code ?? 1));
  });
}
function runSync(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts, shell: true, windowsHide: true });
  return { code: r.status ?? (r.error ? 1 : -1), out: (r.stdout || "") + (r.stderr || ""), error: r.error };
}
/** 收集输出的命令运行（用于 npm view 等）。 */
function runCollect(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const lines = [];
    const child = spawn(cmd, args.map(sanitizeArg), {
      ...opts, shell: true, windowsHide: true, env: { ...process.env, ...(opts.env || {}) },
    });
    const push = (b) => lines.push(...String(b).split(/\r?\n/));
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    child.on("error", (e) => resolve({ code: 127, lines: [], out: String(e.message) }));
    child.on("close", (code) => resolve({ code: code ?? 1, lines, out: lines.join("\n") }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 将 GitHub Release 正文转成干净的纯文本简介：去 HTML、去 markdown 链接壳、折叠空行、去掉 “Full Changelog” 尾注。 */
function cleanReleaseBody(body) {
  if (!body || !body.trim()) return "";
  return String(body)
    .replace(/<[^>]+>/g, "")                                   // 去 HTML 标签
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")                    // markdown 链接保留文本
    .replace(/\r\n|\r/g, "\n")
    .split("\n").map((s) => s.trim())
    .filter((s) => s
      && !/^full change\s*/i.test(s)
      && !/^\s*-----/.test(s)
      && !/^(中文|english)(\s*)(\||&|·|,)(\s*)(中文|english)$/i.test(s))
    .join("\n")
    .replace(/\n{2,}/g, "\n");
}

/** 获取某版本（npm 版本号，映射到 GitHub Release tag `dsh-v<version>`）的官方发布简介。网络失败或缺失返回 null。 */
async function releaseNoteForVersion(version) {
  const tag = `dsh-v${normVersion(version)}`;
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tags/${encodeURIComponent(tag)}`, {
      headers: { "Accept": "application/vnd.github+json", "User-Agent": "dsh_manager" },
    });
    if (!res.ok) return null;
    const j = await res.json();
    return cleanReleaseBody(j && j.body);
  } catch { return null; }
}

/* ------------------------------- 任务 / SSE ------------------------------- */

let activeTask = null;
const taskHistory = [];

function sseBroadcast(payload) {
  const data = "data: " + JSON.stringify(payload) + "\n\n";
  for (const c of sseClients) { try { c.res.write(data); } catch {} }
}
function listenTask(t, text) {
  const line = { at: new Date().toISOString(), text };
  t.lines.push(line);
  sseBroadcast({ type: "task:line", id: t.id, line });
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, `${t.name.replace(/[^\w.-]/g, "_").slice(0, 30) || "task"}.log`), `[${new Date().toISOString()}] ${text}\n`, "utf8");
  } catch { /* ignore */ }
}
async function startTask(name) {
  if (activeTask) throw new Error(`已有任务进行中：${activeTask.name}，请等待完成`);
  activeTask = { id: String(Date.now()), name, startedAt: Date.now(), status: "running", lines: [] };
  sseBroadcast({ type: "task:start", task: summary(activeTask) });
  return activeTask;
}
function summary(t) {
  if (!t) return null;
  return { id: t.id, name: t.name, status: t.status, startedAt: t.startedAt, finishedAt: t.finishedAt, error: t.error, lineCount: t.lines.length };
}
function finishTask(t, ok, err) {
  t.status = ok ? "done" : "error";
  t.finishedAt = Date.now();
  if (err) { t.error = String(err); listenTask(t, "[ERROR] " + String(err)); }
  taskHistory.unshift(summary(t));
  if (taskHistory.length > 50) taskHistory.length = 50;
  activeTask = null;
  sseBroadcast({ type: "task:end", id: t.id, status: t.status });
}

/* ------------------------------- 备份 / 还原 ------------------------------- */

/**
 * 目录统计。全量递归遍历在数据目录较大时可能阻塞事件循环使服务失去响应，
 * 故用 maxFiles 设置上限，达到即停止并标记 truncated（homeSize 仅用于展示，允许近似值）。
 */
function dirStats(dir, maxFiles = 200000) {
  const files = []; const dirs = []; let over = false;
  const walk = (d) => {
    if (over) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (over) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { dirs.push(p); walk(p); }
      else if (e.isFile()) {
        try { files.push({ size: fs.statSync(p).size }); } catch {}
        if (maxFiles && files.length >= maxFiles) { over = true; return; }
      }
    }
  };
  try { walk(dir); } catch {}
  return { size: files.reduce((s, f) => s + f.size, 0), files: files.length, dirs: dirs.length, truncated: over };
}
/**
 * 异步、有界的数据目录统计。全量遍历在数据目录较大时可能阻塞事件循环使
 * 服务失去响应；故用 fs.promises 异步遍历并以 maxFiles 设上限（达到即停止）。
 * 返回值仅用于展示，允许近似。
 */
async function asyncDirStats(dir, maxFiles = 300000) {
  let files = 0; let dirs = 0; let size = 0; let over = false;
  const walk = async (d) => {
    if (over) return;
    let ents;
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (over) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { dirs++; await walk(p); }
      else if (e.isFile()) {
        try { size += (await fsp.stat(p)).size; } catch {}
        files++;
        if (maxFiles && files >= maxFiles) { over = true; break; }
      }
    }
  };
  await walk(dir);
  return { size, files, dirs, truncated: over };
}
let homeSizeStats = null; let homeSizeAt = 0; let homeSizeUpdating = false;
/** 后台刷新数据目录大小缓存（不阻塞调用方）。 */
function refreshHomeSize() {
  const home = resolveDshHome();
  if (homeSizeUpdating) return;
  if (!fs.existsSync(home)) { homeSizeStats = null; homeSizeAt = 0; return; }
  homeSizeUpdating = true;
  (async () => {
    try { homeSizeStats = await asyncDirStats(home, 300000); homeSizeAt = Date.now(); }
    catch { /* 忽略 */ }
    finally { homeSizeUpdating = false; }
  })();
}
function homeSizeNeedsRefresh() {
  return !homeSizeUpdating && (!homeSizeStats || Date.now() - homeSizeAt > 120000);
}
/** status 读取数据目录大小缓存；尚未统计到时返回 null（前端显示占位）。 */
function cachedHomeSize() {
  return homeSizeStats ? homeSizeStats.size : null;
}
const backupStatsCache = new Map(); // id -> { size, files, at }
/** 有界近似 + 60s 缓存的备份大小统计，供缺 manifest 的备份在列表/状态里显示而不阻塞。 */
function backupStat(dir, id) {
  const now = Date.now();
  const c = backupStatsCache.get(id);
  if (c && now - c.at < 60000) return c;
  const st = dirStats(dir, 2000); // 采样上限，仅展示用
  const obj = { size: st.size, files: st.files, at: now };
  backupStatsCache.set(id, obj);
  if (backupStatsCache.size > 200) {
    const oldest = [...backupStatsCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) backupStatsCache.delete(oldest[0]);
  }
  return obj;
}
function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  let names = [];
  try { names = fs.readdirSync(BACKUP_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!BACKUP_RE.test(name)) continue;
    const dir = path.join(BACKUP_DIR, name);
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(path.join(dir, "_manifest.json"), "utf8")); } catch {}
    let size = manifest && isFinite(manifest.size) ? manifest.size : null;
    let files = manifest && isFinite(manifest.files) ? manifest.files : null;
    if (size === null || files === null) {
      const st = backupStat(dir, name); // 无 manifest（如中断残留）时用有界近似 + 缓存，避免阻塞
      size = st.size; files = st.files;
    }
    out.push({
      id: name, name, dir, size, files,
      created: manifest ? manifest.created : "",
      version: manifest ? manifest.version : "",
      kind: manifest ? manifest.kind : "backup",
    });
  }
  out.sort((a, b) => String(b.created || "").localeCompare(String(a.created || "")));
  return out;
}
function backupId(tsStr, version) {
  const tag = String(version || "unknown").replace(/[^\w.-]/g, "_").slice(0, 24);
  return `dsh-${tsStr}-${tag}`;
}
async function copyDir(src, dest, tl) {
  // 排除可复装的 node_modules / .git 等，大幅提升备份速度与体积（也避开超长路径）
  // robocopy 的 GBK 进度会与 UTF-8 日志冲突且过于嘈杂，因此这里不转发它的明细，只等其结束
  if (isWin) {
    const code = await run({
      cmd: "robocopy",
      args: [`"${src}"`, `"${dest}"`, "/E", "/XD", "node_modules", ".git", "__pycache__", ".pytest_cache", "/R:1", "/W:1", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/NC", "/NS"],
      label: "backup", onLine: () => {},
    });
    if (code >= 8) throw new Error(`robocopy 备份出错 (code=${code})`);
  } else {
    const code = await run({ cmd: "rsync", args: ["-a", "--exclude=node_modules", "--exclude=.git", `${src}/`, `${dest}/`], onLine: (l) => tl(l) })
      .catch(() => -1);
    if (code !== 0) await run({ cmd: "cp", args: ["-a", src, dest], onLine: (l) => tl(l) });
  }
}
async function createBackup({ kind = "backup", version = "", overwrite = false }, tl) {
  const src = resolveDshHome();
  if (!fs.existsSync(src)) throw new Error(`数据目录不存在：${src}`);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const now = new Date();
  const id = backupId(
    now.toISOString().slice(0, 10).replace(/-/g, "") + "-" + now.toISOString().slice(11, 19).replace(/:/g, ""),
    version || installedVersion(),
  );
  const dest = path.join(BACKUP_DIR, id);
  if (fs.existsSync(dest)) {
    if (!overwrite) throw new Error(`备份已存在：${id}（勾选“覆盖旧备份”可覆盖）`);
    fs.rmSync(dest, { recursive: true, force: true });
  }
  tl(`备份 ${src} -> ${dest}`);
  await copyDir(src, dest, tl);
  const fin = dirStats(dest);
  fs.writeFileSync(path.join(dest, "_manifest.json"), JSON.stringify({
    kind, version: version || installedVersion(), created: new Date().toISOString(),
    source: src, files: fin.files, size: fin.size,
  }, null, 2), "utf8");
  const all = listBackups();
  if (all.length > config.maxBackups) {
    for (const r of all.slice(config.maxBackups)) { tl(`清理旧备份：${r.id}`); fs.rmSync(r.dir, { recursive: true, force: true }); }
  }
  return id;
}
async function restoreBackup(id, { safety }, tl) {
  const backup = listBackups().find((b) => b.id === id);
  if (!backup) throw new Error(`备份不存在：${id}`);
  const destHome = resolveDshHome();
  if (safety && fs.existsSync(destHome)) {
    tl("先做安全性备份（防止还原出错）...");
    await createBackup({ kind: "autosafe", version: "pre-restore", overwrite: false }, tl);
  }
  tl(`还原 ${backup.dir} -> ${destHome}`);
  const tmp = destHome + ".restore-tmp";
  fs.rmSync(tmp, { recursive: true, force: true });
  await copyDir(backup.dir, tmp, tl);
  fs.rmSync(destHome, { recursive: true, force: true });
  fs.renameSync(tmp, destHome);
  tl("还原完成");
}

/* ------------------------------- npm 安装 / 检测 / 升级 ------------------------------- */

function installPkgDir() {
  const seg = INSTALL_PKG.split("/");
  return path.join(config.installDir, "node_modules", ...seg);
}
/** 当前受管安装的 dsh 版本（未安装返回空串）。 */
function installedVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(installPkgDir(), "package.json"), "utf8")).version || ""; }
  catch { return ""; }
}
function hasInstall() {
  return fs.existsSync(path.join(installPkgDir(), "package.json"));
}

/** 只读查询 npm 注册表（如 dist-tags / versions），返回解析后的值。 */
async function npmView(args) {
  const r = await runCollect("npm", ["view", INSTALL_PKG, ...args, "--json"], {});
  if (r.code === 127) throw new Error("未检测到 npm（请先安装 Node.js）");
  if (r.code !== 0) throw new Error(`npm view 失败 (${r.code}): ${r.out.slice(0, 300)}`);
  return r.out.trim();
}
/** npm dist-tags 映射：{ latest, next, alpha, … }。 */
async function channelMap() {
  try { const j = JSON.parse(await npmView(["dist-tags"])); return (j && typeof j === "object") ? j : {}; }
  catch { return {}; }
}
/** 所有已发布版本（按 semver 倒序）。 */
async function publishedVersions() {
  let arr = [];
  try { const j = JSON.parse(await npmView(["versions"])); if (Array.isArray(j)) arr = j; } catch { arr = []; }
  return arr.map(normVersion)
    .filter((v) => v && /^\d+\.\d+\.\d+/.test(v))
    .map((v) => ({ v }))
    .sort((a, b) => cmpSemver(b.v, a.v));
}
/** 当前配置渠道对应的目标版本（如 latest 流指向 0.1.2-rc.1）。 */
async function targetVersionForChannel() {
  const m = await channelMap();
  return normVersion(m[config.channel] || m.latest || "") || null;
}

/** 安装 dsh 到受管目录：version 为空则按 config.channel 装渠道最新。 */
async function npmInstall(version, tl) {
  const target = version ? normVersion(version) : ((await targetVersionForChannel()) || config.channel);
  fs.mkdirSync(config.installDir, { recursive: true });
  const spec = `${INSTALL_PKG}@${target}`;
  tl(`npm install --prefix ${config.installDir} ${spec} ...`);
  const code = await run({
    cmd: "npm",
    args: ["--prefix", config.installDir, "install", spec, "--no-fund", "--no-audit", "--no-save", "--loglevel=error"],
    cwd: config.installDir, label: "npm", onLine: tl,
  });
  if (code !== 0) throw new Error(`npm install 失败 (exit=${code})，请查看上方日志恢复`);
  tl("安装完成");
}
/** 确保已安装 dsh（未安装则装 channel 最新）。 */
async function ensureInstalled(tl) {
  if (hasInstall()) return;
  tl(`未安装 Harness，安装 ${INSTALL_PKG}（渠道 ${config.channel}）...`);
  await npmInstall(null, tl);
}
/** 升级/回滚公共入口：version 为空则升到 channel 最新。 */
async function switchVersion(t, version, { backup }, tl) {
  const target = version ? normVersion(version) : ((await targetVersionForChannel()) || config.channel);
  tl(`== 目标版本：${target} ==`);
  if (backup && config.autoBackupBeforeUpgrade) {
    tl("升级/回滚前自动备份数据 ...");
    await createBackup({ kind: "pre-upgrade", version: target, overwrite: false }, tl);
  } else {
    tl("跳过升级前备份（未开启）");
  }
  await npmInstall(target, tl);
}

/* ------------------------------- dsh web 进程托管 ------------------------------- */

const WEB = { proc: null, pid: null, startedAt: null, recentLog: [], url: null };
/** 受管安装的 dsh CLI 主入口绝对路径（bin 声明；解析失败返回空串）。 */
function dshBinFile() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(installPkgDir(), "package.json"), "utf8"));
    const b = pkg && pkg.bin;
    let rel = "";
    if (typeof b === "string") rel = b;
    else if (b && typeof b === "object") rel = b.dsh || b[Object.keys(b)[0]] || "";
    if (rel) return path.resolve(installPkgDir(), String(rel).replace(/^\.\//, ""));
  } catch { /* 未安装 */ }
  return "";
}
function webBinPath() {
  const f = dshBinFile();
  return { cmd: f ? process.execPath : "", args: f ? [f] : [] };
}
function isWebRunning() { return !!(WEB.proc && WEB.proc.exitCode === null); }
function probeWebPort(port) {
  try {
    const r = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true });
    const hits = (r.stdout || "").split(/\r?\n/).filter((l) => /LISTENING/.test(l) && l.includes(":" + port));
    return hits.length > 0;
  } catch { return false; }
}
function stopWeb() {
  if (!isWebRunning()) return false;
  try { WEB.proc.kill(); } catch {}
  try { spawnSync("taskkill", ["/PID", String(WEB.pid), "/T", "/F"], { windowsHide: true }); } catch {}
  WEB.proc = null;
  sseBroadcast({ type: "web:change", web: webState() });
  return true;
}
function webState() {
  const running = isWebRunning();
  let external = false;
  if (running && config.webPort > 0) external = probeWebPort(config.webPort);
  return {
    running,
    pid: running ? WEB.pid : null,
    startedAt: running ? WEB.startedAt : null,
    mode: "npm", profile: config.launchProfile,
    configuredPort: config.webPort,
    externalOccupied: external,
    url: running ? WEB.url : null,
    recentLog: running ? WEB.recentLog.slice(-200) : [],
  };
}

/** 在默认浏览器打开 URL；失败静默忽略。 */
function openBrowser(url) {
  try {
    if (process.platform === "win32") exec(`start "" "${url}"`);
    else if (process.platform === "darwin") exec(`open "${url}"`);
    else exec(`xdg-open "${url}"`);
  } catch { /* 打开失败不影响主流程 */ }
}
async function launchWeb() {
  if (isWebRunning()) throw new Error("dsh web 已在运行");
  const bin = webBinPath();
  if (!bin.cmd || !fs.existsSync(bin.args[0])) {
    throw new Error(`尚未安装 Harness（受管目录 ${config.installDir}），请先在“环境/检测更新”处安装后再启动`);
  }
  const args = [...bin.args, "--profile", config.launchProfile];
  if (config.webPort > 0) args.push("--port", String(config.webPort));
  const env = { ...process.env, [DSHDIR_ENV]: resolveDshHome() };
  WEB.recentLog = []; WEB.url = null;
  const child = spawn(bin.cmd, args, { cwd: config.installDir, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  WEB.proc = child; WEB.pid = child.pid; WEB.startedAt = Date.now();
  const emit = (buf) => String(buf).split(/\r?\n/).forEach((line) => {
    const text = stripAnsi(line);
    if (!text) return;
    WEB.recentLog.push(text);
    if (WEB.recentLog.length > 500) WEB.recentLog.shift();
    const m = text.match(/https?:\/\/(localhost|127\.0\.0\.1):(\d+)/);
    if (m && !WEB.url) { WEB.url = `http://localhost:${m[2]}`; sseBroadcast({ type: "web:change", web: webState() }); }
    sseBroadcast({ type: "web:line", line: text });
  });
  child.stdout.on("data", emit);
  child.stderr.on("data", emit);
  child.on("exit", () => { WEB.proc = null; sseBroadcast({ type: "web:change", web: webState() }); });
  sseBroadcast({ type: "web:change", web: webState() });
  return webState();
}

/* ------------------------------- HTTP ------------------------------- */

let sseClients = [];
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};
function sendJson(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); }
function sendError(res, code, msg) { sendJson(res, code || 500, { ok: false, error: String(msg) }); }
function jsonBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

function envInfo() {
  const info = { node: "", npm: "", warnings: [], nodeOk: null, nodeMessage: "" };
  const nodeR = runSync("node", ["-v"]);
  info.node = (nodeR.out || "").trim();
  const npmR = runSync("npm", ["-v"]);
  info.npm = (npmR.out || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null;
  if (!info.node) { info.warnings.push("未检测到 node"); info.nodeOk = false; }
  else {
    const parts = info.node.replace(/^v/i, "").split(".").map(Number);
    const good = (parts[0] === 22 && parts[1] >= 19) || (parts[0] >= 24 && parts[0] < 25);
    info.nodeOk = good;
    info.nodeMessage = good ? `node ${parts[0]}.${parts[1]}.${parts[2]} 满足要求` : `node ${parts[0]}.${parts[1]}.${parts[2]} 不满足要求（${NODE_NEED}），安装可能失败`;
    if (!good) info.warnings.push(info.nodeMessage);
  }
  info.nodeHelp = DEP_HELP.node;
  return info;
}

function envMissing() {
  const e = envInfo();
  const missing = [];
  if (!e.node || !e.nodeOk) missing.push("node");
  return missing;
}

/* ------------------------------- 新人依赖 / Harness 安装 ------------------------------- */

const DEP_INSTALL_CMDS = {
  node: [["winget", "install", "--id", "OpenJS.NodeJS.LTS", "--silent", "--accept-package-agreements", "--accept-source-agreements"]],
};

function whichExe(name) {
  const r = runSync("where", [name]);
  return /not found|could not|找不到/i.test((r.out || "") + (r.err || "")) ? false : !!r.out;
}

async function autoInstallTools(atools) {
  const tools = (atools && atools.length ? atools : envMissing()).filter((t) => DEP_INSTALL_CMDS[t] && !((envInfo().node && envInfo().nodeOk)));
  if (!tools.length) return { installed: [], skipped: tools };
  const t = await startTask("自动安装依赖：" + tools.join(", "));
  try {
    for (const tool of tools) {
      if (tool === "node" && !whichExe("winget")) {
        listenTask(t, `[warn] 系统未检测到 winget，无法自动安装 ${tool}；请改用“打开官方下载页”手动安装。`);
        continue;
      }
      for (const [cmd, ...args] of DEP_INSTALL_CMDS[tool]) {
        const code = await run({ cmd, args, label: tool, onLine: (l) => listenTask(t, l) });
        if (code !== 0) throw new Error(`${tool} 安装失败 (exit=${code})`);
      }
    }
    finishTask(t, true);
    return { installed: tools, skipped: [] };
  } catch (e) { finishTask(t, false, e); throw e; }
}

/** 首次/手动安装入口：把 Harness 官方 npm 包装进受管目录。 */
async function installHarness(tl) {
  const t = await startTask("安装 DeepSeek Harness（npm）");
  try {
    await ensureInstalled((l) => listenTask(t, l));
    finishTask(t, true);
    return { ok: true, installedVersion: installedVersion(), installDir: config.installDir };
  } catch (e) { finishTask(t, false, e); throw e; }
}

function statusPayload() {
  const home = resolveDshHome();
  return {
    ok: true,
    installDir: config.installDir, installed: hasInstall(),
    version: installedVersion(), channel: config.channel,
    home, homeSize: cachedHomeSize(),
    onboarded: !!config.onboarded, envMissing: envMissing(),
    web: webState(), env: envInfo(), backups: listBackups(),
    task: summary(activeTask), taskHistory,
    mixed: config,
  };
}

/* ------------------------------- dsh 命令控制台 ------------------------------- */
const CONSOLE = { proc: null, id: null, cmd: "", startedAt: null, lines: [] };
function consoleStatus() {
  const running = !!(CONSOLE.proc && CONSOLE.proc.exitCode === null);
  return { running, id: running ? CONSOLE.id : null, cmd: CONSOLE.cmd, startedAt: running ? CONSOLE.startedAt : null, lines: CONSOLE.lines.slice(-800) };
}
function consoleEmit(type, payload) { try { sseBroadcast({ type, ...payload }); } catch { /* ignore */ } }
function consoleLine(text) {
  const line = { at: Date.now(), text };
  CONSOLE.lines.push(line);
  if (CONSOLE.lines.length > 1500) CONSOLE.lines = CONSOLE.lines.slice(-1500);
  consoleEmit("console:line", { id: CONSOLE.id, line });
}
function dshBinArgs() {
  const f = dshBinFile();
  return f ? [process.execPath, f] : [process.execPath, ""];
}
// 仅接受 “dsh <参数>” 形式；以 argv 传参，不经 shell，规避命令注入。
function tokenizeDsh(input) {
  const s = String(input || "").trim();
  if (!/^dsh(?:\s|$)/i.test(s)) return null;
  const args = []; let cur = "", q = "";
  for (const ch of s.replace(/^dsh\b/i, "")) {
    if (q) { if (ch === q) q = ""; else cur += ch; }
    else if (ch === '"' || ch === "'") q = ch;
    else if (/\s/.test(ch)) { if (cur) { args.push(cur); cur = ""; } }
    else cur += ch;
  }
  if (cur) args.push(cur);
  return args;
}
function runConsoleCommand(input) {
  if (CONSOLE.proc && CONSOLE.proc.exitCode === null) throw new Error("已有 dsh 命令在运行，请先“停止”");
  const args = tokenizeDsh(input);
  if (!args) throw new Error("只支持以 dsh 开头的命令，例如：dsh doctor");
  const base = dshBinArgs();
  const child = spawn(base[0], [...base.slice(1), ...args], {
    cwd: config.installDir, env: { ...process.env, DSH_HOME: resolveDshHome() }, windowsHide: false,
  });
  CONSOLE.proc = child;
  CONSOLE.cmd = "dsh " + args.join(" ");
  CONSOLE.startedAt = Date.now();
  CONSOLE.lines = [];
  CONSOLE.id = String(Date.now());
  consoleEmit("console:start", { id: CONSOLE.id, cmd: CONSOLE.cmd });
  const pump = (buf) => { const text = buf.toString("utf8").replace(/\r\n?/g, "\n"); for (const seg of text.split("\n")) if (seg.length) consoleLine(seg); };
  child.stdout.on("data", pump);
  child.stderr.on("data", pump);
  child.on("error", (e) => { CONSOLE.proc = null; consoleLine("【启动失败】" + e.message); });
  child.on("exit", (code) => {
    consoleLine(`[进程结束，退出码 ${code}]`);
    CONSOLE.proc = null;
    consoleEmit("console:end", { id: CONSOLE.id, code });
  });
  return CONSOLE.id;
}
function stopConsoleProcess() {
  if (CONSOLE.proc && CONSOLE.proc.exitCode === null) {
    try {
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(CONSOLE.proc.pid), "/T", "/F"], { windowsHide: true });
      else CONSOLE.proc.kill("SIGTERM");
    } catch { try { CONSOLE.proc.kill(); } catch { /* ignore */ } }
    CONSOLE.proc = null;
  }
}

/* ------------------------------- 插件 Plugin ------------------------------- */

/** 内置 CLI 是否就绪（受管安装的 bin 能否解析到）。 */
function pluginCliAvailable() {
  return !!dshBinFile();
}
/** 转发一条 `dsh plugin ...` 命令（走受管安装的 CLI）。 */
async function runPluginCli(args, tl) {
  const base = dshBinArgs();
  return run({ cmd: base[0], args: [...base.slice(1), ...args], cwd: config.installDir, env: { ...process.env, [DSHDIR_ENV]: resolveDshHome() }, onLine: tl, label: "dsh" });
}
/** GET /api/plugins 汇总载荷（当前 dsh 官方机制仅 Profile 组合包）。 */
function pluginsSummary() {
  const home = resolveDshHome();
  const profiles = plugins.listProfiles(home).map((pr) => ({ ...pr, ...plugins.listProfilePlugins(home, pr.name) }));
  return { ok: true, profiles };
}

async function handleApi(req, res, url) {
  const method = req.method;
  const p = url.pathname;
  if (method === "GET" && p === "/api/status") {
    if (homeSizeNeedsRefresh()) refreshHomeSize();
    return sendJson(res, 200, statusPayload());
  }
  if (method === "GET" && p === "/api/env") return sendJson(res, 200, { ok: true, env: envInfo() });
  if (method === "GET" && p === "/api/deps/help") {
    const e = envInfo();
    return sendJson(res, 200, { ok: true, missing: envMissing(), help: { node: e.nodeHelp } });
  }
  if (method === "POST" && p === "/api/deps/install") {
    const b = await jsonBody(req);
    try { return sendJson(res, 200, { ok: true, ...(await autoInstallTools(b && b.tools)) }); }
    catch (e) { return sendError(res, 500, e.message); }
  }
  if (method === "POST" && p === "/api/install") {
    if (activeTask) return sendError(res, 409, `已有任务进行中：${activeTask.name}`);
    const t = await startTask("安装 DeepSeek Harness（npm）");
    try {
      await ensureInstalled((l) => listenTask(t, l));
      finishTask(t, true);
      return sendJson(res, 200, { ok: true, installed: hasInstall(), version: installedVersion(), installDir: config.installDir });
    } catch (e) { finishTask(t, false, e); return sendError(res, 500, e.message); }
  }
  if (method === "POST" && p === "/api/onboard/ack") {
    config.onboarded = true; saveConfig();
    return sendJson(res, 200, { ok: true });
  }
  if (method === "GET" && p === "/api/backups") return sendJson(res, 200, { ok: true, backups: listBackups() });
  if (method === "GET" && p === "/api/web") return sendJson(res, 200, { ok: true, web: webState() });

  if (method === "GET" && p === "/api/doctor") {
    try {
      const onlyRaw = url.searchParams.get("only");
      const only = onlyRaw ? onlyRaw.split(",").map((s) => s.trim()).filter(Boolean) : null;
      const ctx = doctor.buildContext({ dshHome: resolveDshHome(), installDir: config.installDir, processVersion: process.version });
      const report = await doctor.buildReport(ctx, only);
      return sendJson(res, 200, { ok: true, checkList: doctor.CHECKS.map((c) => ({ id: c.id, title: c.title, level: c.level })), ...report });
    } catch (e) { return sendError(res, 500, e.message); }
  }

  if (method === "GET" && p === "/api/retry") {
    try { return sendJson(res, 200, { ok: true, ...require("./retry").readRetryPolicy(resolveDshHome()) }); }
    catch (e) { return sendError(res, 500, e.message); }
  }
  if (method === "POST" && p === "/api/retry") {
    const b = await jsonBody(req);
    try {
      const r = require("./retry").writeRetryPolicy(resolveDshHome(), {
        topKey: String((b && b.topKey) || ""),
        providerId: String((b && b.providerId) || ""),
        retryPolicy: b && b.retryPolicy,
      });
      return sendJson(res, 200, { ok: true, ...r });
    } catch (e) { return sendError(res, 400, e.message); }
  }

  if (method === "GET" && p === "/api/settings/sections") {
    try { return sendJson(res, 200, { ok: true, ...require("./retry").listTopSections(resolveDshHome()) }); }
    catch (e) { return sendError(res, 500, e.message); }
  }
  if (method === "POST" && p === "/api/settings/sections") {
    const b = await jsonBody(req);
    try {
      const r = require("./retry").writeSection(resolveDshHome(), String((b && b.key) || ""), { source: String((b && b.text) || "") });
      return sendJson(res, 200, { ok: true, ...r });
    } catch (e) { return sendError(res, 400, e.message); }
  }

  if (method === "GET" && p === "/api/console") return sendJson(res, 200, { ok: true, console: consoleStatus() });
  if (method === "POST" && p === "/api/console/exec") {
    const b = await jsonBody(req);
    try { const id = runConsoleCommand((b && b.input) || ""); return sendJson(res, 200, { ok: true, id }); }
    catch (e) { return sendError(res, 400, e.message); }
  }
  if (method === "POST" && p === "/api/console/stop") {
    stopConsoleProcess();
    return sendJson(res, 200, { ok: true, console: consoleStatus() });
  }

  if (method === "GET" && p === "/api/plugins") {
    try { return sendJson(res, 200, pluginsSummary()); }
    catch (e) { return sendError(res, 500, e.message); }
  }
  // profile：纯改 JSON 的同步操作
  if (method === "POST" && p === "/api/plugins/profile/toggle") {
    const b = await jsonBody(req);
    const profile = String((b && b.profile) || ""), pkg = String((b && b.pkg) || "");
    if (!profile || !pkg) return sendError(res, 400, "缺少 profile / pkg");
    try {
      const r = plugins.setProfilePluginEnabled(resolveDshHome(), { profile, pkg, enabled: b.enabled !== false });
      return sendJson(res, 200, { ok: true, ...r, ...plugins.listProfilePlugins(resolveDshHome(), profile) });
    } catch (e) { return sendError(res, 400, e.message); }
  }
  // profile：涉及 CLI 安装操作 → activeTask（防并发），结束返回最新列表
  if (method === "POST" && p === "/api/plugins/profile/add") {
    const b = await jsonBody(req);
    const profile = String((b && b.profile) || ""), spec = String((b && b.packageSpec) || "").trim();
    if (!profile || !spec) return sendError(res, 400, "缺少 profile / packageSpec");
    // 导入本地包/目录：spec 可指向 .tgz 包文件或已解压的插件目录，安装前先校验路径存在，避免走进 pnpm 才报错
    if (/^(?:file|link):/i.test(spec) || path.isAbsolute(spec) || /^\.{1,2}[\\/]/.test(spec) || /\.tgz(?:#|$)/i.test(spec)) {
      // 只剥离 file:/link: 协议前缀；不要像旧的正则 /^[a-z]+:/ 那样误删 Windows 盘符（E: 等），
      // 否则裸绝对路径会被解析到错误盘符的目录上。
      const raw = spec.replace(/^(?:file|link):/i, "");
      const localPath = path.isAbsolute(raw) ? raw : path.resolve(raw);
      if (!fs.existsSync(localPath)) return sendError(res, 400, `本地包/目录不存在：${spec}（解析路径：${localPath}）`);
    }
    if (activeTask) return sendError(res, 409, `已有任务进行中：${activeTask.name}`);
    // 记录安装前依赖，用于安装后探测「装了但没被当插件启用」的包
    let beforeDeps = new Set();
    try { beforeDeps = new Set(plugins.listProfilePlugins(resolveDshHome(), profile).dependencies || []); } catch { /* profile 尚未初始化，忽略 */ }
    const t = await startTask(`安装 profile 插件 ${spec}`);
    try {
      if (pluginCliAvailable()) {
        const code = await runPluginCli(["plugin", "--profile", profile, "add", spec], (l) => listenTask(t, l));
        if (code !== 0) throw new Error(`dsh plugin add 失败 (exit=${code})，请查看上方日志恢复`);
      } else {
        listenTask(t, "[退化] 未检测到 Harness CLI，改为直接编辑 profile 的 package.json（需在该 profile 目录手动 pnpm install）");
        plugins.addProfilePluginDirect(resolveDshHome(), { profile, packageSpec: spec, bundle: b.bundle !== false });
      }
      // 用户明确取消 bundle 时，确保不进入 bundle 层（针对自带 dsh.bundle 声明的包）
      if (b.bundle === false) {
        try { plugins.setProfilePluginEnabled(resolveDshHome(), { profile, pkg: plugins.specToPkg(spec), enabled: false }); } catch { /* 依赖已按需处理 */ }
      }
      finishTask(t, true);
      const after = plugins.listProfilePlugins(resolveDshHome(), profile);
      const afterDeps = new Set(after.dependencies || []);
      const enabled = new Set(after.plugins.map((p) => p.pkg));
      // 探测新增且用户想启用、却没能进 bundle 层的包（多半不是 dsh 插件）
      let notice = null;
      if (b.bundle !== false) {
        const added = [...afterDeps].filter((d) => !beforeDeps.has(d) && !enabled.has(d));
        if (added.length) {
          notice = `包「${added.join("、")}」已作为普通依赖安装，但未被识别为 dsh 插件，无法当作插件启用；如确认非插件可稍后卸载。`;
        }
      }
      return sendJson(res, 200, { ok: true, profile, packageSpec: spec, notice, ...after });
    } catch (e) { finishTask(t, false, e); return sendError(res, 500, e.message); }
  }
  if (method === "POST" && p === "/api/plugins/profile/remove") {
    const b = await jsonBody(req);
    const profile = String((b && b.profile) || ""), pkg = String((b && b.pkg) || "");
    if (!profile || !pkg) return sendError(res, 400, "缺少 profile / pkg");
    if (activeTask) return sendError(res, 409, `已有任务进行中：${activeTask.name}`);
    const t = await startTask(`卸载 profile 插件 ${pkg}`);
    try {
      if (pluginCliAvailable()) {
        const code = await runPluginCli(["plugin", "--profile", profile, "remove", pkg], (l) => listenTask(t, l));
        if (code !== 0) throw new Error(`dsh plugin remove 失败 (exit=${code})，请查看上方日志恢复`);
      } else {
        listenTask(t, "[退化] 未检测到 Harness CLI，改为直接编辑 profile 的 package.json（需在该 profile 目录手动 pnpm install）");
        plugins.removeProfilePluginDirect(resolveDshHome(), { profile, pkg });
      }
      finishTask(t, true);
      return sendJson(res, 200, { ok: true, profile, pkg, ...plugins.listProfilePlugins(resolveDshHome(), profile) });
    } catch (e) { finishTask(t, false, e); return sendError(res, 500, e.message); }
  }

  if (method === "POST" && p === "/api/config") {
    const b = await jsonBody(req);
    if (typeof b.installDir === "string" && b.installDir.trim()) config.installDir = path.resolve(expandTilde(b.installDir.trim()));
    if (typeof b.channel === "string" && CHANNELS.includes(b.channel)) config.channel = b.channel;
    if (typeof b.dshHome === "string") config.dshHome = b.dshHome.trim();
    if (Number.isFinite(b.port)) config.port = Math.max(1024, Math.min(65535, Math.round(b.port)));
    if (Number.isFinite(b.webPort)) config.webPort = Math.max(0, Math.min(65535, Math.round(b.webPort)));
    if (typeof b.launchProfile === "string" && NAME_RE.test(b.launchProfile)) config.launchProfile = b.launchProfile;
    if (typeof b.autoBackupBeforeUpgrade === "boolean") config.autoBackupBeforeUpgrade = b.autoBackupBeforeUpgrade;
    if (typeof b.safetyBackupBeforeRestore === "boolean") config.safetyBackupBeforeRestore = b.safetyBackupBeforeRestore;
    if (Number.isFinite(b.maxBackups)) config.maxBackups = Math.max(0, Math.min(50, Math.round(b.maxBackups)));
    if (["127.0.0.1", "0.0.0.0", "localhost"].includes(b.bindHost)) config.bindHost = b.bindHost;
    saveConfig();
    return sendJson(res, 200, { ok: true, config });
  }

  if (method === "GET" && p === "/api/versions") {
    try {
      const [versions, channels] = await Promise.all([publishedVersions(), channelMap()]);
      return sendJson(res, 200, { ok: true, versions, channels, channel: config.channel, current: installedVersion() });
    } catch (e) { return sendError(res, 500, e.message); }
  }

  if (method === "GET" && p === "/api/updates/check") {
    if (activeTask) return sendError(res, 409, `已有任务进行中：${activeTask.name}`);
    const t = await startTask("检查更新");
    try {
      const [versions, channels] = await Promise.all([publishedVersions(), channelMap()]);
      finishTask(t, true);
      const current = installedVersion();
      const latestV = normVersion(channels[config.channel] || channels.latest || "") || (versions[0] && versions[0].v) || "";
      const latest = latestV || null;
      const hasUpdate = !!latest && (!current || cmpSemver(latest, current) > 0);
      const newer = (hasUpdate && current ? versions.filter((x) => cmpSemver(x.v, current) > 0) : []).slice(0, 20);
      return sendJson(res, 200, { ok: true, current, latest, channel: config.channel, channels, hasUpdate, newer, versions });
    } catch (e) { finishTask(t, false, e); return sendError(res, 500, e.message); }
  }

  if (method === "GET" && p === "/api/updates/changelog") {
    try {
      const toRaw = normVersion(url.searchParams.get("to") || "");
      if (!toRaw || !/^\d+\.\d+\.\d+/.test(toRaw)) return sendError(res, 400, "缺少有效的目标版本 to");
      const from = normVersion(installedVersion()) || toRaw;
      const releaseNote = await releaseNoteForVersion(toRaw);
      return sendJson(res, 200, { ok: true, from, to: toRaw, releaseNote });
    } catch (e) { return sendError(res, 500, e.message); }
  }

  if (method === "POST" && p === "/api/upgrade") {
    const b = await jsonBody(req);
    if (activeTask) return sendError(res, 409, `已有任务进行中：${activeTask.name}`);
    const t = await startTask("升级 Harness");
    try {
      const raw = b && b.target !== undefined ? String(b.target) : "";
      let target = null;
      if (raw) {
        if (CHANNELS.includes(raw)) {
          const m = await channelMap();
          target = normVersion(m[raw] || m.latest || "");
          if (!target) throw new Error(`渠道 ${raw} 当前无可用版本`);
        } else {
          target = normVersion(raw);
          if (!/^\d+\.\d+\.\d+/.test(target)) throw new Error("无效的版本 target");
        }
      }
      await switchVersion(t, target, { backup: b.autoBackup !== false }, (l) => listenTask(t, l));
      finishTask(t, true);
      return sendJson(res, 200, { ok: true });
    } catch (e) { finishTask(t, false, e); return sendError(res, 500, e.message); }
  }

  if (method === "POST" && p === "/api/rollback") {
    const b = await jsonBody(req);
    const raw = String((b && (b.version || b.tag)) || "").trim();
    if (!raw || !/^\d+\.\d+\.\d+/.test(normVersion(raw))) return sendError(res, 400, "缺少有效的版本号");
    if (activeTask) return sendError(res, 409, `已有任务进行中：${activeTask.name}`);
    const t = await startTask(`回滚到 ${normVersion(raw)}`);
    try {
      await switchVersion(t, normVersion(raw), { backup: b.autoBackup !== false }, (l) => listenTask(t, l));
      finishTask(t, true);
      return sendJson(res, 200, { ok: true });
    } catch (e) { finishTask(t, false, e); return sendError(res, 500, e.message); }
  }

  if (method === "POST" && p === "/api/backup") {
    const b = await jsonBody(req);
    if (activeTask) return sendError(res, 409, `已有任务进行中：${activeTask.name}`);
    const t = await startTask("备份数据");
    try {
      await createBackup({ version: installedVersion(), overwrite: b.overwrite === true }, (l) => listenTask(t, l));
      finishTask(t, true);
      return sendJson(res, 200, { ok: true, backups: listBackups() });
    } catch (e) { finishTask(t, false, e); return sendError(res, 500, e.message); }
  }

  if (method === "POST" && p === "/api/backup/restore") {
    const b = await jsonBody(req);
    const id = safeId(b.id, BACKUP_RE);
    if (!id) return sendError(res, 400, "无效的备份 id");
    if (activeTask) return sendError(res, 409, `已有任务进行中：${activeTask.name}`);
    if (isWebRunning()) return sendError(res, 409, "请先停止 dsh web 再还原数据");
    const t = await startTask(`还原备份 ${id}`);
    try {
      await restoreBackup(id, { safety: b.safety !== false && config.safetyBackupBeforeRestore }, (l) => listenTask(t, l));
      finishTask(t, true);
      return sendJson(res, 200, { ok: true, backups: listBackups() });
    } catch (e) { finishTask(t, false, e); return sendError(res, 500, e.message); }
  }

  if (method === "POST" && p === "/api/backup/delete") {
    const b = await jsonBody(req);
    const id = safeId(b.id, BACKUP_RE);
    if (!id) return sendError(res, 400, "无效的备份 id");
    const target = listBackups().find((x) => x.id === id);
    if (!target) return sendError(res, 404, "备份不存在");
    fs.rmSync(target.dir, { recursive: true, force: true });
    return sendJson(res, 200, { ok: true, backups: listBackups() });
  }

  if (method === "POST" && p === "/api/launch") {
    try { const st = await launchWeb(); return sendJson(res, 200, { ok: true, web: st }); }
    catch (e) { return sendError(res, 500, e.message); }
  }
  if (method === "POST" && p === "/api/stop") {
    const did = stopWeb();
    return sendJson(res, 200, { ok: true, stopped: did, web: webState() });
  }

  return sendError(res, 404, `未知接口 ${p}`);
}

/* ------------------------------- 服务器 ------------------------------- */

function serveStatic(res, filePath) {
  let data;
  try { data = fs.readFileSync(filePath); }
  catch { return sendError(res, 404, "Not Found"); }
  res.writeHead(200, { "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
  res.end(data);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write("retry: 3000\n\n");
    const client = { res };
    sseClients.push(client);
    req.on("close", () => { sseClients = sseClients.filter((c) => c !== client); });
    return;
  }
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url).catch((e) => sendError(res, 500, e.message));

  let rel = url.pathname.slice(1) || "index.html";
  const segments = path.normalize(rel).split(/[\\/]/).filter((s) => s && s !== "..");
  const filePath = path.join(PUBLIC_DIR, ...segments);
  if (!filePath.startsWith(PUBLIC_DIR)) return sendError(res, 403, "Forbidden");
  return serveStatic(res, filePath);
});

function start() {
  saveConfig();
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  refreshHomeSize();
  let port = config.port || DEFAULT_CONFIG.port;
  const listen = (p) => {
    const srv = server.listen(p, config.bindHost, () => {
      console.log("==============================================");
      console.log("  dsh_manager 已启动");
      console.log(`  管理界面 : http://${config.bindHost}:${p}`);
      console.log(`  安装目录 : ${config.installDir}（渠道 ${config.channel}，版本 ${installedVersion() || "未安装"}）`);
      console.log(`  数据目录 : ${resolveDshHome()}`);
      console.log("  按 Ctrl+C 退出");
      console.log("==============================================");
      if (process.env.DSH_MANAGER_OPEN_BROWSER === "1") openBrowser(`http://${config.bindHost}:${p}`);
    });
    srv.on("error", (e) => {
      if (e.code === "EADDRINUSE") {
        console.log(`端口 ${p} 被占用，尝试 ${p + 1}`);
        srv.close();
        return listen(p + 1);
      }
      console.error("启动失败:", e.message);
      process.exit(1);
    });
  };
  listen(port);
}

process.on("SIGINT", () => { stopWeb(); process.exit(0); });
process.on("SIGTERM", () => { stopWeb(); process.exit(0); });

start();