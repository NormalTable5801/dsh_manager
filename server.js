/* =====================================================================
 * dsh_manager  server.js
 * 零依赖 Node 服务：为 DeepSeek Harness 提供 WebUI 管理界面。
 * 功能：一键启动/停止 dsh web、检测更新与升级、git 源码版本列表与回滚、
 *       ~/.dsh 数据备份 / 还原 / 覆盖、环境检测、构建、进程托管、SSE 日志。
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

/* ---------------------------------------------------------------
 * 插件候选源搜索（npm registry / GitHub）
 * 只读对外 HTTP 请求，用于把「可安装的 spec」搜出来给用户选择；
 * 真正的安装仍走现有 /api/plugins/profile/add（dsh plugin … add <spec>）。
 * --------------------------------------------------------------- */
const NPM_SEARCH = "https://registry.npmjs.org/-/v1/search";
const GITHUB_SEARCH = "https://api.github.com/search/repositories";
const SEARCH_TIMEOUT_MS = 12000;

async function _fetchSearch(url) {
  const headers = { "User-Agent": "dsh-manager", "Accept": "application/vnd.github+json" };
  const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (ghToken) headers.Authorization = `Bearer ${ghToken}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`远端请求失败 HTTP ${res.status}${res.status === 429 || res.status === 403 ? "（GitHub 未认证限流 10 次/分钟，稍后再试或设置 GITHUB_TOKEN）" : ""}`);
  return res.json();
}

/** 按关键词在 npm registry 搜索 → 追加 npm 候选卡片。失败时记一条带 error 的卡片。 */
async function searchNpm(q, into) {
  try {
    const j = await _fetchSearch(`${NPM_SEARCH}?text=${encodeURIComponent(q)}&size=20`);
    const seen = new Set();
    for (const o of (j.objects || [])) {
      const pkg = o.package || {};
      if (!pkg.name || seen.has(pkg.name)) continue;
      seen.add(pkg.name);
      into.push({
        source: "npm",
        label: `${pkg.name}@${pkg.version || ""}`,
        spec: `${pkg.name}@${pkg.version || ""}`,
        description: pkg.description || "",
        extra: "npm registry",
        pnpmGate: false,
      });
    }
  } catch (e) { into.push({ source: "npm", error: e.message }); }
}

/** 按关键词搜索 GitHub 仓库 → 追加 git 候选卡片。带 pnpm build 白名单提示。 */
async function searchGithub(q, into) {
  try {
    const j = await _fetchSearch(`${GITHUB_SEARCH}?q=${encodeURIComponent(q)}&per_page=20`);
    for (const it of (j.items || [])) {
      into.push({
        source: "github",
        label: it.full_name,
        spec: `github:${it.full_name}`,
        description: it.description || "",
        extra: `github · ${it.stargazers_count || 0}★`,
        pnpmGate: true,
        pnpmGateText: "git 源若被 pnpm 拦截构建，需在 profiles/<name>/pnpm-workspace.yaml 的 allowBuilds 加白名单后重装",
      });
    }
  } catch (e) { into.push({ source: "github", error: e.message }); }
}

/* ------------------------------- 常量 ------------------------------- */

const ROOT = __dirname;                  // dsh_manager 目录
const PUBLIC_DIR = path.join(ROOT, "public");
const CONFIG_PATH = path.join(ROOT, "config.json");
const BACKUP_DIR = path.join(ROOT, "backups");
const LOG_DIR = path.join(ROOT, "logs");

const DSH_DIR_NAME = ".dsh";
const DSHDIR_ENV = "DSH_HOME";
const OFFICIAL_REMOTE = "https://github.com/deepseek-ai/deepseek-harness.git";
const OFFICIAL_REMOTE_NAME = "origin";

const isWin = process.platform === "win32";
const NODE_NEED = "node ^22.19.x（或 24.x）";

/* ------------------------------- 配置 ------------------------------- */

// 新人依赖安装指引（默认走引导式：复制命令 / 打开官方页；点“自动安装”才用 winget/corepack 半自动）。
// cmd 是可复制给用户的安装命令；url 是官方下载页。
const DEP_HELP = {
  node: { cmd: "winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements", url: "https://nodejs.org/zh-cn/download" },
  pnpm: { cmd: "corepack enable\ncorepack prepare pnpm@latest --activate", url: "https://pnpm.io/zh/installation" },
  git:  { cmd: "winget install --id Git.Git --silent --accept-package-agreements --accept-source-agreements", url: "https://git-scm.com/download/win" },
};

const DEFAULT_CONFIG = {
  repoPath: "",                 // 留空自动发现
  onboarded: false,             // 是否已完成首次引导（写入被 gitignore 的 config.json）
  dshHome: "",                  // 留空 => %USERPROFILE%\.dsh / $DSH_HOME
  port: 8730,
  webPort: 0,                   // >0 用于探活与识别访问地址
  launchProfile: "web",
  launchMode: "built",          // built | source
  officialRemote: OFFICIAL_REMOTE,
  autoBackupBeforeUpgrade: true,
  safetyBackupBeforeRestore: true,
  maxBackups: 10,
  bindHost: "127.0.0.1",
};

let config = loadConfig();

function defaultRepoPath() {
  // 在 dsh_manager 的上级目录里找 package.json name === "@deepseek-ai/dsh-root" 的根仓库
  const parent = path.dirname(ROOT);
  let found = "";
  try {
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkg = path.join(parent, entry.name, "package.json");
      if (!fs.existsSync(pkg)) continue;
      let name = "";
      try { name = JSON.parse(fs.readFileSync(pkg, "utf8")).name || ""; } catch { /* ignore */ }
      if (name === "@deepseek-ai/dsh-root") { found = path.join(parent, entry.name); break; }
    }
  } catch { /* ignore */ }
  return found;
}

function loadConfig() {
  const base = { ...DEFAULT_CONFIG };
  try {
    if (fs.existsSync(CONFIG_PATH)) Object.assign(base, JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
  } catch { /* ignore */ }
  base.repoPath = base.repoPath || defaultRepoPath();
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
function toVersionList(tags) {
  return tags
    .map((t) => ({ tag: t, v: t.replace(/^dsh-?/i, "").replace(/^v/i, "") }))
    .filter((x) => /^\d+\.\d+/.test(x.v))
    .sort((x, y) => cmpSemver(y.v, x.v));
}

/* ------------------------------- 命令执行 ------------------------------- */

function sanitizeArg(a) {
  if (typeof a !== "string") return "";
  if (/[\r\n&|;`<>$]/.test(a)) return "";
  return a;
}
/** 运行命令并逐行回调，返回退出码（Promise）。Windows 用 shell:true 以支持 pnpm.cmd 等 shim。 */
function run({ cmd, args, cwd, env, onLine, label }) {
  return new Promise((resolve) => {
    const safeArgs = args.map(sanitizeArg);
    const child = spawn(cmd, safeArgs, {
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
/** 收集输出的命令运行（用于 git ls-remote 等）。 */
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
function coreRef(repo) {
  const t = runSync("git", ["describe", "--tags", "--exact-match", "HEAD"], { cwd: repo });
  if (t.code === 0) return t.out.trim();
  const c = runSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo });
  const b = runSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo });
  return `${(b.out || "detached").trim()}@${(c.out || "?").trim()}`;
}
function packageVersion(repo) {
  try { return JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version || ""; }
  catch { return ""; }
}
function hasRemote(repo) {
  const r = runSync("git", ["remote"], { cwd: repo });
  return (r.out || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean).includes(OFFICIAL_REMOTE_NAME);
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
    version || packageVersion(config.repoPath),
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
    kind, version: version || packageVersion(config.repoPath), created: new Date().toISOString(),
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

/* ------------------------------- git / 构建 / 升级 ------------------------------- */

async function ensureRemote(tl) {
  if (hasRemote(config.repoPath)) return;
  tl(`添加官方 remote：${config.officialRemote}`);
  const code = await run({ cmd: "git", args: ["remote", "add", OFFICIAL_REMOTE_NAME, config.officialRemote], cwd: config.repoPath, label: "git", onLine: tl });
  if (code !== 0) throw new Error("添加 remote 失败");
}
/**
 * 只读地列出官方远程的所有 tag（git ls-remote，无需下载仓库对象，秒级）。
 * 用于“检测更新 / 版本列表”。
 */
async function remoteTags() {
  await ensureRemote(() => {});
  const r = await runCollect("git", ["ls-remote", "--tags", OFFICIAL_REMOTE_NAME], { cwd: config.repoPath });
  if (r.code !== 0) throw new Error(`ls-remote 失败 (${r.code}): ${r.out.slice(0, 300)}`);
  const seen = new Set();
  for (const line of r.lines) {
    const sp = line.split(/\s+/);
    if (sp.length < 2 || !sp[1].startsWith("refs/tags/")) continue;
    let t = sp[1].slice("refs/tags/".length);
    if (t.endsWith("^{}")) t = t.slice(0, -3); // 注解 tag 的二次引用
    if (t) seen.add(t);
  }
  return toVersionList([...seen]);
}
function localTags() {
  const r = runSync("git", ["tag", "-l"], { cwd: config.repoPath });
  return (r.out || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}
/** 按需拉取单个 tag 的仓库对象（比全量 fetch 轻量得多）。 */
async function fetchTag(tag, tl) {
  await ensureRemote(tl);
  tl(`拉取版本 ${tag} ...`);
  const code = await run({ cmd: "git", args: ["fetch", OFFICIAL_REMOTE_NAME, `+refs/tags/${tag}:refs/tags/${tag}`, "--force"], cwd: config.repoPath, label: "git", onLine: tl });
  if (code !== 0) throw new Error(`拉取 ${tag} 失败 (exit=${code})，请检查网络`);
}
async function checkoutTag(t, tag, tl) {
  const clean = runSync("git", ["status", "--porcelain"], { cwd: config.repoPath });
  const trackedDirty = (clean.out || "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^\?\?/.test(l));
  if (trackedDirty.length) {
    throw new Error(`仓库有 ${trackedDirty.length} 处已跟踪改动，为避免丢失，请先在仓库提交或撤销后再切换：\n${trackedDirty.slice(0, 8).join("\n")}`);
  }
  tl(`切换到版本 ${tag} ...`);
  const code = await run({ cmd: "git", args: ["checkout", "--force", tag], cwd: config.repoPath, label: "git", onLine: tl });
  if (code !== 0) throw new Error(`切换到 ${tag} 失败 (exit=${code})`);
}
async function build(tagRef, tl) {
  tl("pnpm install ...");
  let code = await run({ cmd: "pnpm", args: ["install"], cwd: config.repoPath, label: "pnpm", onLine: tl });
  if (code !== 0) throw new Error(`pnpm install 失败 (exit=${code})`);
  // 版本切换后 git checkout 不会清除被忽略的旧 lib 构建产物，残留产物会污染启动与增量构建，
  // 因此每次构建前先 pnpm clean（只删生成物，保留 node_modules，store 复用不重复下载）。
  tl("pnpm clean（清理旧构建产物）...");
  code = await run({ cmd: "pnpm", args: ["clean"], cwd: config.repoPath, label: "pnpm", onLine: tl });
  if (code !== 0) throw new Error(`pnpm clean 失败 (exit=${code})`);
  tl("pnpm build ...");
  code = await run({ cmd: "pnpm", args: ["run", "build"], cwd: config.repoPath, label: "pnpm", onLine: tl });
  if (code !== 0) throw new Error(`pnpm build 失败 (exit=${code})`);
  tl("构建完成");
}
async function switchVersion(t, tag, { backup }, tl) {
  tl(`== 目标版本：${tag} ==`);
  if (backup && config.autoBackupBeforeUpgrade) {
    tl("升级/回滚前自动备份数据 ...");
    await createBackup({ kind: "pre-upgrade", version: tag, overwrite: false }, tl);
  } else {
    tl("跳过升级前备份（未开启）");
  }
  await fetchTag(tag, tl);
  await checkoutTag(t, tag, tl);
  await build(t, tl);
}

/* ------------------------------- dsh web 进程托管 ------------------------------- */

const WEB = { proc: null, pid: null, startedAt: null, recentLog: [], url: null };
function webBinPath() {
  if (config.launchMode === "source") {
    return { cmd: process.execPath, args: ["--import", "tsx/esm", path.join(config.repoPath, "apps/cli/src/bin.ts")] };
  }
  return { cmd: process.execPath, args: [path.join(config.repoPath, "apps/cli/lib/bin.js")] };
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
    mode: config.launchMode, profile: config.launchProfile,
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
  if (config.launchMode === "built" && !fs.existsSync(path.join(config.repoPath, "apps/cli/lib/bin.js"))) {
    throw new Error("缺少构建产物 apps/cli/lib/bin.js，请先“构建”，或在设置里把启动方式切换为 source");
  }
  const args = [...bin.args, "--profile", config.launchProfile];
  if (config.webPort > 0) args.push("--port", String(config.webPort));
  const env = { ...process.env, [DSHDIR_ENV]: resolveDshHome() };
  WEB.recentLog = []; WEB.url = null;
  const child = spawn(bin.cmd, args, { cwd: config.repoPath, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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
  const info = { node: "", pnpm: "", git: "", warnings: [], nodeOk: null, nodeMessage: "" };
  const nodeR = runSync("node", ["-v"]);
  info.node = (nodeR.out || "").trim();
  const pnpmR = runSync("pnpm", ["-v"]);
  const pm = (pnpmR.out || "").split(/\r?\n/).map((s) => s.trim()).map((s) => s.match(/^v?\d+\.\d+\.\d+/)).filter(Boolean).map((m) => m[0]);
  info.pnpm = pm[0] || null;
  const gitR = runSync("git", ["--version"]);
  info.git = (gitR.out || "").trim();
  if (!info.node) { info.warnings.push("未检测到 node"); info.nodeOk = false; }
  else {
    const parts = info.node.replace(/^v/i, "").split(".").map(Number);
    const good = (parts[0] === 22 && parts[1] >= 19) || (parts[0] >= 24 && parts[0] < 25);
    info.nodeOk = good;
    info.nodeMessage = good ? `node ${parts[0]}.${parts[1]}.${parts[2]} 满足要求` : `node ${parts[0]}.${parts[1]}.${parts[2]} 不满足要求（${NODE_NEED}），构建可能失败`;
    if (!good) info.warnings.push(info.nodeMessage);
  }
  if (!info.pnpm) info.warnings.push("未检测到 pnpm");
  info.nodeHelp = DEP_HELP.node;
  info.pnpmHelp = DEP_HELP.pnpm;
  info.gitHelp = DEP_HELP.git;
  return info;
}

function envMissing() {
  const e = envInfo();
  const missing = [];
  if (!e.node || !e.nodeOk) missing.push("node");
  if (!e.pnpm) missing.push("pnpm");
  if (!e.git) missing.push("git");
  return missing;
}

/* ------------------------------- 新人依赖安装 / 仓库获取 ------------------------------- */

const DEP_INSTALL_CMDS = {
  node: [["winget", "install", "--id", "OpenJS.NodeJS.LTS", "--silent", "--accept-package-agreements", "--accept-source-agreements"]],
  pnpm: [["corepack", "enable"], ["corepack", "prepare", "pnpm@latest", "--activate"]],
  git: [["winget", "install", "--id", "Git.Git", "--silent", "--accept-package-agreements", "--accept-source-agreements"]],
};

function whichExe(name) {
  const r = runSync("where", [name]);
  return /not found|could not|找不到/i.test((r.out || "") + (r.err || "")) ? false : !!r.out;
}

async function autoInstallTools(atools) {
  const tools = (atools && atools.length ? atools : envMissing()).filter((t) => DEP_INSTALL_CMDS[t] && !(t === "node" ? (envInfo().node && envInfo().nodeOk) : envInfo()[t]));
  if (!tools.length) return { installed: [], skipped: tools };
  const t = await startTask("自动安装依赖：" + tools.join(", "));
  try {
    for (const tool of tools) {
      if ((tool === "node" || tool === "git") && !whichExe("winget")) {
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

async function ensureHarnessRepo() {
  const has = config.repoPath && fs.existsSync(path.join(config.repoPath, "package.json"));
  if (has) return { already: true, repoPath: config.repoPath };
  const target = path.join(path.dirname(ROOT), "deepseek-harness");
  const t = await startTask("获取 Harness 源码（git clone）");
  try {
    const code = await run({ cmd: "git", args: ["clone", "--depth", "1", OFFICIAL_REMOTE, target], label: "git", onLine: (l) => listenTask(t, l) });
    if (code !== 0) throw new Error(`git clone 失败 (exit=${code})`);
    config.repoPath = target;
    saveConfig();
    finishTask(t, true);
    return { already: false, repoPath: target };
  } catch (e) { finishTask(t, false, e); throw e; }
}

function statusPayload() {
  const repo = config.repoPath;
  const repoExists = fs.existsSync(path.join(repo, "package.json"));
  const home = resolveDshHome();
  let version = "", ref = null, dirty = { count: 0, msg: "" };
  let remoteConfigured = false;
  if (repoExists) {
    version = packageVersion(repo);
    try { ref = coreRef(repo); } catch {}
    const d = runSync("git", ["status", "--porcelain"], { cwd: repo });
    const lines = (d.out || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    dirty.count = lines.length;
    if (lines.length) {
      const tracked = lines.filter((l) => !/^\?\?/.test(l));
      dirty.msg = tracked.length ? `${tracked.length} 处已跟踪改动` : `仅 ${lines.length} 个未跟踪文件`;
    }
    remoteConfigured = hasRemote(repo);
  }
  return {
    ok: true,
    repoPath: repo, repoExists, home, homeSize: cachedHomeSize(),
    version, gitRef: ref, dirty, remoteConfigured,
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
  if (config.launchMode === "source") return [process.execPath, "--import", "tsx/esm", path.join(config.repoPath, "apps/cli/src/bin.ts")];
  return [process.execPath, path.join(config.repoPath, "apps/cli/lib/bin.js")];
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
    cwd: config.repoPath, env: { ...process.env, DSH_HOME: resolveDshHome() }, windowsHide: false,
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

/** 内置 CLI 是否就绪（built 产物或 source 入口能否解析到）。 */
function pluginCliAvailable() {
  if (config.launchMode === "source") return fs.existsSync(path.join(config.repoPath, "apps/cli/src/bin.ts"));
  return fs.existsSync(path.join(config.repoPath, "apps/cli/lib/bin.js"));
}
/** 转发一条 `dsh plugin ...` 命令（自动跑 pnpm 并 reconcile bundle 层）。 */
async function runPluginCli(args, tl) {
  const base = dshBinArgs();
  return run({ cmd: base[0], args: [...base.slice(1), ...args], cwd: config.repoPath, env: { ...process.env, [DSHDIR_ENV]: resolveDshHome() }, onLine: tl, label: "dsh" });
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
    return sendJson(res, 200, { ok: true, missing: envMissing(), help: { node: e.nodeHelp, pnpm: e.pnpmHelp, git: e.gitHelp } });
  }
  if (method === "POST" && p === "/api/deps/install") {
    const b = await jsonBody(req);
    try { return sendJson(res, 200, { ok: true, ...(await autoInstallTools(b && b.tools)) }); }
    catch (e) { return sendError(res, 500, e.message); }
  }
  if (method === "POST" && p === "/api/deps/clone") {
    try { return sendJson(res, 200, { ok: true, ...(await ensureHarnessRepo()) }); }
    catch (e) { return sendError(res, 500, e.message); }
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
      const ctx = doctor.buildContext({ dshHome: resolveDshHome(), repoPath: config.repoPath, processVersion: process.version });
      const report = await doctor.buildReport(ctx, only);
      return sendJson(res, 200, { ok: true, checkList: doctor.CHECKS.map((c) => ({ id: c.id, title: c.title, level: c.level })), ...report });
    } catch (e) { return sendError(res, 500, e.message); }
  }
  if (method === "POST" && p === "/api/doctor/fix") {
    const b = await jsonBody(req);
    let fix;
    try {
      if (b.target === "settings") fix = doctor.fixSettings(resolveDshHome());
      else if (b.target === "credentials") fix = doctor.fixCredentials(resolveDshHome(), b.value || "");
      else return sendError(res, 400, "未知修复目标（settings | credentials）");
    } catch (e) { return sendError(res, 500, e.message); }
    return sendJson(res, 200, { ok: true, fix });
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
  // 搜索候选插件源：GET /api/plugins/search?sources=npm,github&q=<关键词>
  if (method === "GET" && p === "/api/plugins/search") {
    const q = String(url.searchParams.get("q") || "").trim();
    if (!q) return sendError(res, 400, "缺少搜索关键词 q");
    const sources = (url.searchParams.get("sources") || "npm,github").split(",").map((s) => s.trim()).filter(Boolean);
    const cards = [];
    await Promise.all([sources.includes("npm") ? searchNpm(q, cards) : Promise.resolve(), sources.includes("github") ? searchGithub(q, cards) : Promise.resolve()]);
    return sendJson(res, 200, { ok: true, cards });
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
  // profile：涉及 pnpm / CLI 的操作 → activeTask（防并发），结束返回最新列表
  if (method === "POST" && p === "/api/plugins/profile/add") {
    const b = await jsonBody(req);
    const profile = String((b && b.profile) || ""), spec = String((b && b.packageSpec) || "").trim();
    if (!profile || !spec) return sendError(res, 400, "缺少 profile / packageSpec");
    if (activeTask) return sendError(res, 409, `已有任务进行中：${activeTask.name}`);
    const t = await startTask(`安装 profile 插件 ${spec}`);
    try {
      if (pluginCliAvailable()) {
        const code = await runPluginCli(["plugin", "--profile", profile, "add", spec], (l) => listenTask(t, l));
        if (code !== 0) throw new Error(`dsh plugin add 失败 (exit=${code})，请查看上方日志恢复`);
      } else {
        listenTask(t, "[退化] 缺少 CLI 构建产物，改为直接编辑 package.json（需重启后手动 pnpm install）");
        plugins.addProfilePluginDirect(resolveDshHome(), { profile, packageSpec: spec, bundle: b.bundle !== false });
      }
      // 用户明确取消 bundle 时，确保不进入 bundle 层（针对自带 dsh.bundle 声明的包）
      if (b.bundle === false) {
        try { plugins.setProfilePluginEnabled(resolveDshHome(), { profile, pkg: plugins.specToPkg(spec), enabled: false }); } catch { /* 依赖已按需处理 */ }
      }
      finishTask(t, true);
      return sendJson(res, 200, { ok: true, profile, packageSpec: spec, ...plugins.listProfilePlugins(resolveDshHome(), profile) });
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
        listenTask(t, "[退化] 缺少 CLI 构建产物，改为直接编辑 package.json（需重启后手动 pnpm install）");
        plugins.removeProfilePluginDirect(resolveDshHome(), { profile, pkg });
      }
      finishTask(t, true);
      return sendJson(res, 200, { ok: true, profile, pkg, ...plugins.listProfilePlugins(resolveDshHome(), profile) });
    } catch (e) { finishTask(t, false, e); return sendError(res, 500, e.message); }
  }

  if (method === "POST" && p === "/api/config") {
    const b = await jsonBody(req);
    if (typeof b.repoPath === "string" && b.repoPath.trim()) config.repoPath = b.repoPath.trim();
    if (typeof b.dshHome === "string") config.dshHome = b.dshHome.trim();
    if (Number.isFinite(b.port)) config.port = Math.max(1024, Math.min(65535, Math.round(b.port)));
    if (Number.isFinite(b.webPort)) config.webPort = Math.max(0, Math.min(65535, Math.round(b.webPort)));
    if (["built", "source"].includes(b.launchMode)) config.launchMode = b.launchMode;
    if (typeof b.launchProfile === "string" && NAME_RE.test(b.launchProfile)) config.launchProfile = b.launchProfile;
    if (typeof b.officialRemote === "string" && /^https:\/\//.test(b.officialRemote)) config.officialRemote = b.officialRemote.trim();
    if (typeof b.autoBackupBeforeUpgrade === "boolean") config.autoBackupBeforeUpgrade = b.autoBackupBeforeUpgrade;
    if (typeof b.safetyBackupBeforeRestore === "boolean") config.safetyBackupBeforeRestore = b.safetyBackupBeforeRestore;
    if (Number.isFinite(b.maxBackups)) config.maxBackups = Math.max(0, Math.min(50, Math.round(b.maxBackups)));
    if (["127.0.0.1", "0.0.0.0", "localhost"].includes(b.bindHost)) config.bindHost = b.bindHost;
    saveConfig();
    return sendJson(res, 200, { ok: true, config });
  }

  if (method === "GET" && p === "/api/versions") {
    try {
      const d = runSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: config.repoPath });
      let remote = [];
      let remoteOk = true;
      try { remote = await remoteTags(); } catch { remoteOk = false; }
      const local = toVersionList(localTags());
      return sendJson(res, 200, {
        ok: true,
        versions: remote.length ? remote : local, remoteOk,
        current: packageVersion(config.repoPath),
        gitRef: coreRef(config.repoPath), branch: (d.out || "").trim(),
      });
    } catch (e) { return sendError(res, 500, e.message); }
  }

  if (method === "GET" && p === "/api/updates/check") {
    if (activeTask) return sendError(res, 409, `已有任务进行中：${activeTask.name}`);
    const t = await startTask("检查更新");
    try {
      const tags = await remoteTags(); // 秒级，仅读引用
      finishTask(t, true);
      const current = packageVersion(config.repoPath);
      const latest = tags[0] || null;
      const newer = latest && cmpSemver(latest.v, current) > 0 ? tags.filter((x) => cmpSemver(x.v, current) > 0) : [];
      return sendJson(res, 200, { ok: true, current, latest: latest ? latest.tag : null, hasUpdate: newer.length > 0, newer, versions: tags });
    } catch (e) { finishTask(t, false, e); return sendError(res, 500, e.message); }
  }

  if (method === "POST" && p === "/api/remote/add") {
    if (activeTask) return sendError(res, 409, `已有任务进行中：${activeTask.name}`);
    const t = await startTask("配置官方 remote");
    try { await ensureRemote((l) => listenTask(t, l)); finishTask(t, true); return sendJson(res, 200, { ok: true }); }
    catch (e) { finishTask(t, false, e); return sendError(res, 500, e.message); }
  }

  if (method === "POST" && p === "/api/build") {
    if (activeTask) return sendError(res, 409, `已有任务进行中：${activeTask.name}`);
    const t = await startTask("构建 Harness");
    try {
      await build(t, (l) => listenTask(t, l));
      finishTask(t, true);
      return sendJson(res, 200, { ok: true });
    } catch (e) { finishTask(t, false, e); return sendError(res, 500, e.message); }
  }

  if (method === "POST" && p === "/api/upgrade") {
    const b = await jsonBody(req);
    if (activeTask) return sendError(res, 409, `已有任务进行中：${activeTask.name}`);
    const t = await startTask("升级 Harness");
    try {
      const tag = b.target && TAG_RE.test(b.target) ? b.target : "latest";
      let targetTag = tag;
      if (tag === "latest") {
        const tags = await remoteTags();
        targetTag = tags[0] ? tags[0].tag : null;
        if (!targetTag) throw new Error("未获取到任何版本标签");
      }
      await switchVersion(t, targetTag, { backup: b.autoBackup !== false }, (l) => listenTask(t, l));
      finishTask(t, true);
      return sendJson(res, 200, { ok: true });
    } catch (e) { finishTask(t, false, e); return sendError(res, 500, e.message); }
  }

  if (method === "POST" && p === "/api/rollback") {
    const b = await jsonBody(req);
    const tag = safeId(b.tag, TAG_RE);
    if (!tag) return sendError(res, 400, "缺少有效的版本 tag");
    if (activeTask) return sendError(res, 409, `已有任务进行中：${activeTask.name}`);
    const t = await startTask(`回滚到 ${tag}`);
    try {
      await switchVersion(t, tag, { backup: b.autoBackup !== false }, (l) => listenTask(t, l));
      finishTask(t, true);
      return sendJson(res, 200, { ok: true });
    } catch (e) { finishTask(t, false, e); return sendError(res, 500, e.message); }
  }

  if (method === "POST" && p === "/api/backup") {
    const b = await jsonBody(req);
    if (activeTask) return sendError(res, 409, `已有任务进行中：${activeTask.name}`);
    const t = await startTask("备份数据");
    try {
      await createBackup({ version: packageVersion(config.repoPath), overwrite: b.overwrite === true }, (l) => listenTask(t, l));
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
      console.log(`  仓库     : ${config.repoPath || "(未配置)"}`);
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