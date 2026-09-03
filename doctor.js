/* =====================================================================
 * dsh_manager / doctor.js
 * Harness 诊断引擎（纯融入、重写自 moonquake2004/dsh-doctor v0.4.4）。
 *
 * 本文件把上游 dsh-doctor 的完整诊断逻辑（离线）改写为 CommonJS 版并
 * 嵌进 dsh_manager，而非链接外部文件：
 *   - Layer A 内置检查：env（E1-E6/E10） / profile（P0-P15） / session（S0-S11 / 全会话扫描）
 *   - Layer A 远程检查目录 catalog：声明式只读探测规则（内置 5 条 + 每 6h 拉取远端）
 *   - Layer B 版本检查：npm 上游版本 vs 本端口版本（仅提示，不自动更新）
 *
 * 零依赖，仅用 Node 内置模块。不执行远程代码（catalog 规则是数据、只读探测原语）。
 * 凭据只做“存在性/来源链”判定，绝不回显任何 key 的值。
 *
 * 对外契约（与 server.js / public/app.js 兼容）：
 *   buildContext(opts)                      构建诊断上下文（opts: dshHome/repoPath/processVersion…）
 *   buildReport(ctx, only?)   (async)       跑完整引擎并返回 { checkList, findings, summary, healthy, version, meta }
 *                                           其中 findings: [{ checkId,title,level,severity,message,remediation,detail }]
 *                                            severity ∈ ok | warn | error | skip
 *   CHECKS                                  静态检查清单（checkId/title/level），同 checkList
 *
 * ----------------------------------------------------------------------
 * 版权与许可：
 *   本文件的主体诊断引擎改写自社区同名项目 moonquake2004/dsh-doctor
 *     （MIT License，Copyright (c) 2026 moonquake2004），许可全文见文末。
 * ===================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const { spawnSync, execFileSync } = require("child_process");

/* ------------------------------- 常量 ------------------------------- */

const PORTED_VERSION = "0.4.4";                                  // 对应上游版本，用于 Layer B 版本提示
const PORTED_SOURCE = "moonquake2004/dsh-doctor v0.4.4";

const STORAGE_ROW_TYPES = new Set(["text-chunks", "reasoning-chunks", "tool-call-chunks", "session"]);
// S8：官方 KNOWN_SESSION_EVENT_TYPES（0.1.0-rc.6 内置回退；优先从安装的 dsh-session 解析）
const KNOWN_SESSION_EVENT_TYPES_FALLBACK = new Set([
  "agent-preset/selected", "agent/inbox/spliced", "approval/asked", "approval/decided", "approval/policy",
  "assistant/chunk", "assistant/message", "command/done", "command/run", "compaction/end", "compaction/prune",
  "compaction/start", "compaction/summary", "feedback/record", "goal/change", "hook/invoked", "hook/result",
  "llm/retry", "llm/retry-started", "permission/preset", "plan/mode", "request/context", "request/header",
  "sandbox/mode", "schedule/change", "session/end-seed", "session/title", "session/title-llm-request",
  "step/end", "step/start", "subagent/descriptor", "todo/write", "tool-workflow/agent-end",
  "tool-workflow/agent-start", "tool-workflow/run-end", "tool-workflow/run-start", "tool/call",
  "tool/code-dispatch", "tool/code-dispatch-start", "tool/result", "turn/end", "turn/start", "user/message",
  "web/deepseek-search-llm-request"
]);

const REMOTE_CATALOG_URL = "https://raw.githubusercontent.com/moonquake2004/dsh-doctor/main/plugin/checks.json";
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const UPDATE_URL = "https://registry.npmjs.org/@moonquake2004%2Fdsh-doctor";
const UPDATE_TTL_MS = 6 * 60 * 60 * 1000;

// 内置远程检查目录副本（规则是数据，不是代码；远端不可达时使用）
const BUNDLED_CATALOG = {
  schemaVersion: 1,
  checks: [
    { id: "E7-dsh-in-path", section: "env", severity: "error", title: "dsh 可执行文件在 PATH 中", discussion: "#1270", probe: { type: "command-exists", cmd: "dsh" }, detailOk: "dsh 在 PATH 中可用", detailFail: "dsh 不在 PATH（插件/CLI 安装链路不可用，#1270 同族）", fix: "安装 dsh 并将 node_modules/.bin 加入 PATH" },
    { id: "E8-npmrc-workspace-flag", section: "env", severity: "warn", title: "workspace-root profile 的 .npmrc 安装开关", discussion: "#20", probe: { type: "text-contains", path: "{profile}/.npmrc", pattern: "ignore-workspace-root-check\\s*=\\s*true", flags: "" }, detailOk: "profile .npmrc 已含 ignore-workspace-root-check=true（dsh-market #20 workaround 在位）", detailFail: "profile .npmrc 缺 ignore-workspace-root-check=true——workspace-root profile 上 dsh plugin 安装/更新会报 ERR_PNPM_ADDING_TO_ROOT（dsh-market #20）", fix: "在 {profile}/.npmrc 追加 ignore-workspace-root-check=true" },
    { id: "P6-patch-name-space", section: "profile", severity: "error", title: "patch insert name 含空格（Windows 参数 lint）", discussion: "#1420", probe: { type: "text-not-contains", path: "{profile}/cordis.patch.yml", pattern: "^\\s*name:\\s*['\"]?[^'\"\\s]+[^'\"\\n]*\\s[^'\"\\n]+", flags: "m", required: false }, detailOk: "用户 patch 的 insert name 均无空格", detailFail: "用户 patch 存在含空格的 insert name（Windows 下 spawn 参数解析会断，#1420 待实现 lint 的目录版）", fix: "把含空格的 insert name 改为不含空格的标识符" },
    { id: "E9-storages-json-valid", section: "env", severity: "error", title: "config 目录 JSON 文件合法性", discussion: "#1357", probe: { type: "json-valid", path: "{home}/config/workspace.json", required: false }, detailOk: "config/workspace.json 为合法 JSON", detailFail: "config/workspace.json 不是合法 JSON（#1357 并发写乱码类，工作区列表会消失）", fix: "排查多实例并发写；修复或删除损坏文件" },
    { id: "E11-settings-writable", section: "env", severity: "error", title: "settings.yaml 可写性（sudo 属主问题）", discussion: "#1719", probe: { type: "file-writable", path: "{home}/settings.yaml", required: false }, detailOk: "settings.yaml 可写", detailFail: "settings.yaml 不可写（sudo 安装遗留的属主/权限问题），dsh 无法持久化设置", fix: "把属主改回当前用户：sudo chown <当前用户> ~/.dsh/settings.yaml（或删掉让 dsh 重建）" },
  ],
};

const catalogSeveritySeed = new Map([   // 上游：这些 id 的失败只算 warn，不翻退出码/健康红线
  ["E1-pnpm", "warn"], ["E3-node", "warn"], ["installed_bundle", "warn"], ["P13", "warn"], ["P14", "warn"],
  ["P15", "error"],
]);

/* ------------------------------- 工具 ------------------------------- */

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, shell: true });
  return { status: r.status ?? (r.error ? 127 : -1), stdout: r.stdout || "", stderr: r.stderr || "" };
}
function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
function findCommand(cmd) {
  for (const w of process.platform === "win32" ? ["where"] : ["which"]) {
    const r = spawnSync(w, [cmd]);
    if (r.status === 0) { const p = String(r.stdout).split(/\r?\n/)[0].trim(); if (p) return p; }
  }
  return null;
}
function nodeInSupportedRange(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v));
  if (!m) return false;
  const major = Number(m[1]); const minor = Number(m[2]);
  return (major === 22 && minor >= 19) || major >= 24;
}
function countRecursive(dir) {
  let n = 0;
  try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const fp = path.join(dir, e.name); if (e.isFile()) n++; else if (e.isDirectory()) n += countRecursive(fp); } } catch { /* skip */ }
  return n;
}
/** 极简 glob：`*` 段内任意、`?` 单字符、`**` 递归目录；返回文件匹配数。 */
function globCount(base, pattern) {
  if (!exists(base)) return 0;
  const segs = String(pattern).split("/").filter(Boolean);
  if (segs.length === 0) return 0;
  let dirs = [base];
  let count = 0;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    const next = [];
    if (seg === "**") {
      if (last) { for (const d of dirs) count += countRecursive(d); return count; }
      const all = [...dirs];
      const stack = [...dirs];
      while (stack.length) {
        const d = stack.pop();
        if (!exists(d)) continue;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (!e.isDirectory()) continue;
          all.push(path.join(d, e.name));
          stack.push(path.join(d, e.name));
        }
      }
      dirs = all;
      continue;
    }
    const re = new RegExp("^" + seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + "$");
    for (const d of dirs) {
      if (!exists(d)) continue;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (!re.test(e.name)) continue;
        const fp = path.join(d, e.name);
        if (last) { if (e.isFile()) count++; }
        else if (e.isDirectory()) next.push(fp);
      }
    }
    dirs = next;
  }
  return count;
}
/** 读取安装的 dsh-session 里的 KNOWN_SESSION_EVENT_TYPES 锚点；失败回退内置副本。 */
function knownSessionEventTypes() {
  for (const p of (process.env.PATH || "").split(path.delimiter)) {
    if (!p.endsWith("node_modules/.bin") || !exists(path.join(p, "dsh"))) continue;
    try {
      const src = fs.readFileSync(path.join(path.dirname(p), "@deepseek-ai", "dsh-session", "lib", "index.js"), "utf8");
      const m = /const KNOWN_SESSION_EVENT_TYPES = new Set\(\[(.*?)\]\);/.exec(src);
      if (m) {
        const items = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
        if (items.length) return new Set(items);
      }
    } catch { /* 回退 */ }
    break;
  }
  return KNOWN_SESSION_EVENT_TYPES_FALLBACK;
}

/* ------------------------------- 结果管线 ------------------------------- */

function report(ctx, section, id, ok, detail, fix, opts) {
  ctx.results.push({ section, id, ok, detail, fix, src: (opts && opts.src) || "builtin", skip: !!(opts && opts.skip), severity: opts && opts.severity });
}
function reportSkip(ctx, section, id, detail, src) {
  ctx.results.push({ section, id, ok: true, skip: true, detail, src: src || "builtin" });
}

/* ---------------------------- profile 解析 ---------------------------- */

function resolveProfile(home, name) {
  if (!name) throw new Error("无效 profile 名");
  if (name.includes("/") || name.includes("\\") || name.startsWith("~") || name.startsWith(".")) {
    return name.startsWith("~") ? path.join(os.homedir(), name.slice(1)) : name;
  }
  return path.join(home, "profiles", name);
}

/* ================= env 检查 ================= */

function checkEnv(ctx) {
  for (const cmd of ["node", "pnpm", "zstd"]) {
    const p = findCommand(cmd);
    report(ctx, "env", `E1-${cmd}`, !!p,
      p ? `${cmd}: ${p}` : `${cmd} 不在 PATH（${cmd === "node" ? "创建会话会失败 #1270" : cmd === "pnpm" ? "dsh plugin 不可用（corepack 可恢复：corepack enable pnpm）" : "会话日志解压不可用"}）`,
      p ? undefined : (cmd === "pnpm" ? "corepack enable pnpm 或安装 pnpm 后加入 PATH" : `安装 ${cmd} 或加入 PATH`));
  }
  const envFile = path.join(ctx.home, ".env");
  if (exists(envFile)) {
    const isDir = fs.lstatSync(envFile).isDirectory();
    report(ctx, "env", "E2-env", !isDir,
      isDir ? `${envFile} 是目录，dsh 启动会报 failed to load .env: EISDIR（#71）` : `${envFile} 正常`,
      isDir ? "删除或改名该目录" : undefined);
  }
  const nv = spawnSync("node", ["-e", "console.log(process.version)"]);
  if (nv.status === 0) {
    const version = String(nv.stdout).trim();
    const supported = nodeInSupportedRange(version);
    report(ctx, "env", "E3-node", supported,
      supported ? `node ${version}（满足 ^22.19.0 || >=24.0.0，root package.json engines）` : `node ${version} 不在支持范围（^22.19.0 || >=24.0.0）——会话日志读取等能力受限`,
      supported ? undefined : "升级 node 到 ^22.19.0 或 >=24.0.0（root package.json engines，见 #2259）");
  }
  // E4：node-pty 原生模块完整性（#1219）
  const ptyDirs = [];
  for (const p of (process.env.PATH || "").split(path.delimiter)) {
    if (p.endsWith("node_modules/.bin") && exists(path.join(p, "dsh"))) {
      ptyDirs.push(path.join(path.dirname(p), "node-pty")); break;
    }
  }
  const profileNM = path.join(ctx.home, "profiles", "web", "node_modules");
  ptyDirs.push(path.join(profileNM, "node-pty"));
  const pnpmStore = path.join(profileNM, ".pnpm");
  if (exists(pnpmStore)) {
    for (const d of fs.readdirSync(pnpmStore)) if (d.startsWith("node-pty@")) ptyDirs.push(path.join(pnpmStore, d, "node_modules", "node-pty"));
  }
  const plat = `${process.platform}-${process.arch}`;
  const ptyFound = ptyDirs.filter((d) => exists(d));
  let ptyBinary = null;
  for (const d of ptyFound) {
    for (const bin of [path.join(d, "prebuilds", plat, "pty.node"), path.join(d, "build", "Release", "pty.node")]) {
      if (exists(bin) && fs.statSync(bin).size > 0) { ptyBinary = bin; break; }
    }
    if (ptyBinary) break;
  }
  if (ptyFound.length === 0) report(ctx, "env", "E4", false, "未找到 node-pty（dsh web 终端依赖它，#1219）", "重新安装 @deepseek-ai/dsh，确保 node-pty 装全");
  else if (ptyBinary) report(ctx, "env", "E4", true, `node-pty 原生模块在位（${plat}）`, undefined);
  else report(ctx, "env", "E4", false, `node-pty 存在但缺 ${plat} 原生二进制（#1219: dsh web 启动失败）`, "重装 node-pty（npm rebuild node-pty）或从源码构建");

  // E5：存储 JSON 文件合法性（#1357）
  const storages = path.join(ctx.home, "storages");
  const badStorage = [];
  if (exists(storages)) {
    for (const f of fs.readdirSync(storages)) {
      if (!f.endsWith(".json")) continue;
      const fp = path.join(storages, f);
      let buf;
      try { buf = fs.readFileSync(fp); } catch { badStorage.push(`${f}（读取失败）`); continue; }
      let utf8ok = true;
      try { new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { utf8ok = false; }
      let jsonok = false;
      if (utf8ok) { try { JSON.parse(buf.toString("utf8")); jsonok = true; } catch { /* 非法 JSON */ } }
      if (!jsonok) badStorage.push(`${f}（UTF-8:${utf8ok ? "OK" : "BAD"}，JSON:${jsonok ? "OK" : "BAD"}）`);
    }
  }
  if (badStorage.length) report(ctx, "env", "E5", false, `存储文件损坏（#1357 并发写乱码类）: ${badStorage.join(", ")}`, "排查是否有多个 dsh 实例并发写同一 storages；修复或删除损坏文件");
  else report(ctx, "env", "E5", true, "存储 JSON 文件均合法", undefined);

  // E6：锚点元检查（tripwire）—— S6/S7/S10 依赖的契约是否仍在安装的 dsh-session 里
  let sessionLib = null;
  for (const p of (process.env.PATH || "").split(path.delimiter)) {
    if (p.endsWith("node_modules/.bin") && exists(path.join(p, "dsh"))) {
      const lib = path.join(path.dirname(p), "@deepseek-ai", "dsh-session", "lib", "index.js");
      if (exists(lib)) { sessionLib = lib; break; }
    }
  }
  if (!sessionLib) {
    report(ctx, "env", "E6", true, "⚠ 未定位到 dsh-session，锚点未校验（回退内置假设：expandRow/end-seed/sourceEventSeqs）", "安装 dsh 后重跑可校验");
  } else {
    const src = fs.readFileSync(sessionLib, "utf8");
    const anchors = [
      ["expandRow 的 seq0+k 展开（S6 依赖）", /function expandRow[\s\S]*?row\.seq0/, src],
      ["session/end-seed 字面量（S7 依赖）", /"session\/end-seed"/, src],
      ["sourceEventSeqs 字段（S10 依赖）", /sourceEventSeqs/, src],
    ];
    const missing = anchors.filter(([, re]) => !re.test(src));
    if (missing.length) report(ctx, "env", "E6", false, `锚点缺失（上游可能改了契约，S6/S7/S10 结论需人工复核）: ${missing.map(([n]) => n).join("; ")}（${sessionLib.slice(-60)}）`, "对照上游变更更新 dsh-doctor 的对应检查");
    else report(ctx, "env", "E6", true, `锚点齐全（${anchors.length}/3: seq0+k / session/end-seed / sourceEventSeqs）`, undefined);
  }
}

/* E10：Web 端口可用性（#1719）—— 本地 socket bind 探测（离线兼容） */
function portOccupierInfo(port) {
  try {
    if (process.platform === "win32") {
      const r = execFileSync("netstat", ["-ano"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
      const m = new RegExp(`TCP\\s+[^\\s]+:${port}\\s+.*?LISTENING\\s+(\\d+)`).exec(r);
      if (!m) return null;
      return { pid: m[1], cmd: "", dsh: false };
    }
    const r = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    const lines = r.trim().split("\n").slice(1).filter(Boolean);
    if (!lines.length) return null;
    const parts = lines[0].trim().split(/\s+/);
    const cmd = parts[0] || ""; const pid = parts[1] || "";
    let dsh = /dsh|deepseek/.test(cmd);
    if (!dsh && pid) {
      try { dsh = /dsh web|deepseek-ai|harness/.test(execFileSync("ps", ["-p", pid, "-o", "command="], { encoding: "utf8" })); } catch { /* fallback */ }
      if (!dsh) {
        try {
          const lsofP = execFileSync("lsof", ["-p", pid], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
          dsh = /\.npm\/_npx\/|node_modules\/@deepseek-ai\//.test(lsofP);
        } catch { /* 无法识别则按非 dsh 处理 */ }
      }
    }
    return { pid, cmd, dsh };
  } catch { return null; }
}

function checkPort3080(ctx) {
  return new Promise((resolve) => {
    const port = Number(process.env.DSH_DOCTOR_PORT || 3080);
    const srv = net.createServer();
    srv.unref();
    let done = false;
    const finish = (fn) => (...args) => { if (done) return; done = true; try { fn(...args); } catch { } resolve(); };
    srv.on("error", finish((e) => {
      if (e.code === "EADDRINUSE") {
        const info = portOccupierInfo(port);
        if (info && info.dsh) report(ctx, "env", "E10-port-3080", true, `端口 ${port} 被 dsh web 实例占用（PID ${info.pid}）——宿主自身或另一实例，正常`, undefined);
        else if (info) report(ctx, "env", "E10-port-3080", false, `端口 ${port} 被其他程序占用（PID ${info.pid}: ${info.cmd}），dsh web 启动会 address in use（#1719）`, `关掉占用进程，或让 dsh web 用别的端口`);
        else report(ctx, "env", "E10-port-3080", true, `⚠ 端口 ${port} 被占用但无法识别占用者`, undefined);
      } else {
        report(ctx, "env", "E10-port-3080", false, `端口 ${port} 探测异常: ${e.message.slice(0, 60)}`, undefined);
      }
    }));
    srv.listen(port, "127.0.0.1", finish(() => { try { srv.close(); } catch { } report(ctx, "env", "E10-port-3080", true, `端口 ${port} 空闲`, undefined); }));
  });
}

/* ================= profile 检查 ================= */

function checkProfile(ctx, name) {
  let dir;
  try { dir = resolveProfile(ctx.home, name); } catch (e) { report(ctx, "profile", "P0", false, e.message); return; }
  const manifestPath = path.join(dir, "package.json");
  if (!exists(manifestPath)) { report(ctx, "profile", "P0", false, `profile 不存在: ${dir}`); return; }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  const deps = manifest.dependencies ?? {};

  const installAnchor = (() => {
    for (const p of (process.env.PATH || "").split(path.delimiter)) {
      if (p.endsWith("node_modules/.bin") && exists(path.join(p, "dsh"))) return path.dirname(p);
    }
    return null;
  })();
  const findPkg = (pkgName) => {
    const cands = [
      installAnchor ? path.join(installAnchor, pkgName) : null,
      path.join(dir, "node_modules", pkgName),
    ].filter(Boolean);
    return cands.find((c) => exists(path.join(c, "package.json"))) ?? null;
  };
  const readInsertIds = (patchFile) => {
    const ids = new Set();
    if (!exists(patchFile)) return ids;
    const lines = fs.readFileSync(patchFile, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*)- insert:\s*$/);
      if (!m) continue;
      const base = m[1].length;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() === "") continue;
        const indent = (l.match(/^\s*/) || [""])[0].length;
        if (indent <= base) break;
        const im = l.match(/^\s*-\s*id:\s*['"]?([^'"\s]+)/);
        if (im) ids.add(im[1]);
      }
    }
    return ids;
  };
  const patchPath = path.join(dir, "cordis.patch.yml");
  const userIds = readInsertIds(patchPath);
  const userNames = (() => {
    const out = new Set();
    if (!exists(patchPath)) return out;
    const text = fs.readFileSync(patchPath, "utf8");
    for (const m of text.matchAll(/^\s*name:\s*['"]?([^'"\s]+)/gm)) out.add(m[1]);
    return out;
  })();

  // P1 bundles 可解析性
  for (const b of bundles) {
    const dir2 = findPkg(b);
    if (!dir2) {
      if (!installAnchor) continue;
      report(ctx, "profile", "P1", false, `bundle 条目 ${b} 无法在安装目录或 profile node_modules 解析（#917/#1377/#880）`, `dsh plugin --profile ${name} add ${b} 或从 dsh.profile.bundles 移除`);
    } else {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir2, "package.json"), "utf8"));
      if (!pkg.dsh?.bundle?.patch) report(ctx, "profile", "P1", false, `bundle 条目 ${b} 存在但未声明 dsh.bundle（#1377 静默禁用类）`, "检查该包版本或移除条目");
    }
  }
  // P2 id 冲突（#1404 bundle↔user + #2315 bundle↔bundle）
  const bundleIdSources = new Map();
  for (const b of bundles) {
    const dir2 = findPkg(b);
    if (!dir2) continue;
    const pkg = JSON.parse(fs.readFileSync(path.join(dir2, "package.json"), "utf8"));
    const rel = pkg.dsh?.bundle?.patch;
    if (!rel) continue;
    for (const id of readInsertIds(path.join(dir2, rel))) {
      if (!bundleIdSources.has(id)) bundleIdSources.set(id, new Set());
      bundleIdSources.get(id).add(b);
    }
  }
  const crossBundleDup = [...bundleIdSources].filter(([, s]) => s.size > 1).map(([id, s]) => `${id}（${[...s].join(" + ")}）`);
  const userBundleDup = [...bundleIdSources.keys()].filter((id) => userIds.has(id));
  const p2Issues = [];
  if (crossBundleDup.length) p2Issues.push(`多个 bundle 注册相同 entry id（启动必崩 duplicate loader entry id，#2315）: ${crossBundleDup.join("; ")}`);
  if (userBundleDup.length) p2Issues.push(`bundle 与用户 patch 的 id 冲突（启动必崩 duplicate loader entry id，#1404）: ${userBundleDup.join(", ")}`);
  if (p2Issues.length) report(ctx, "profile", "P2", false, p2Issues.join(" | "), crossBundleDup.length ? "移除冲突 bundle 中的一个（如不兼容的 TUI/standalone 插件误装入 profile），或让上游协商唯一 entry id" : `备份后从 ${patchPath} 删除这些 insert（或运行 check-dsh-profile.mjs 查看详情）`);
  else report(ctx, "profile", "P2", true, "无 bundle/用户 patch id 冲突", undefined);
  // P3 insert name 可解析性
  const bad = [];
  for (const n of userNames) {
    if (n.startsWith("@local/") || n.startsWith("@liustack/")) {
      const fp = deps[n];
      if (fp && fp.startsWith("file:")) {
        const target = path.join(dir, fp.slice(5));
        if (!exists(target)) bad.push(`${n} (file: 目标不存在: ${fp})`);
        continue;
      }
    }
    let ok = false;
    try { require.resolve(n, { paths: [dir] }); ok = true; } catch { ok = false; }
    if (!ok) bad.push(n);
  }
  if (bad.length) report(ctx, "profile", "P3", false, `用户 patch 中不可解析的 name（#1197/#880）: ${bad.join(", ")}`, `dsh plugin --profile ${name} add <包> 或修复 file: 依赖`);
  else report(ctx, "profile", "P3", true, "用户 patch insert 均可解析", undefined);
  // P4 file: 依赖悬空
  const resolveFileSpec = (spec) => {
    const target = spec.slice(5);
    return /^[/\\]|^[A-Za-z]:/.test(target) ? target : path.join(dir, target);
  };
  const dangling = Object.entries(deps).filter(([, spec]) => spec.startsWith("file:")).filter(([, spec]) => !exists(resolveFileSpec(spec)));
  if (dangling.length) report(ctx, "profile", "P4", false, `悬空 file: 依赖（#1197）: ${dangling.map(([n, s]) => `${n} (${s})`).join(", ")}`, "恢复目录或移除依赖");
  else report(ctx, "profile", "P4", true, "file: 依赖完整", undefined);
  // P5 顶层 @deepseek-ai/* 重复（#1486/#1697）
  const topDup = [];
  const topDir = path.join(dir, "node_modules", "@deepseek-ai");
  const hostScope = installAnchor ? path.join(installAnchor, "@deepseek-ai") : null;
  if (exists(topDir)) {
    for (const p of fs.readdirSync(topDir)) {
      const fp = path.join(topDir, p);
      let st;
      try { st = fs.lstatSync(fp); } catch { continue; }
      if (st.isSymbolicLink()) {
        if (!hostScope) continue;
        try {
          const real = fs.realpathSync(fp);
          const hostPkg = path.join(hostScope, p);
          if (exists(hostPkg) && fs.realpathSync(hostPkg) === real) continue;
        } catch { /* 按独立副本处理 */ }
      }
      if (exists(path.join(fp, "package.json"))) topDup.push(p);
    }
  }
  if (topDup.length) report(ctx, "profile", "P5", false, `profile 顶层存在 @deepseek-ai/* 重复（#1486/#1697 双实例风险，hoisted 布局会让同版本工具包互相遮蔽导致 Symbol 不匹配）: ${topDup.join(", ")}`, "清理 profile 顶层 node_modules/@deepseek-ai 中与宿主同名的独立副本（真实目录）；指向宿主的 link: symlink 是安全的（#1697 workaround）");
  else report(ctx, "profile", "P5", true, "无顶层 @deepseek-ai 重复", undefined);

  // P7 patch YAML 结构 lint（#1724）
  const yamlProblems = [];
  const patchText = exists(patchPath) ? fs.readFileSync(patchPath, "utf8") : "";
  if (patchText) {
    const topLines = patchText.split("\n");
    let hasTopMapping = false, hasTopSeq = false;
    topLines.forEach((line, i) => {
      if (!line.trim() || line.trim().startsWith("#")) return;
      if (line.includes("\t")) yamlProblems.push(`第 ${i + 1} 行含制表符缩进（YAML 禁止 tab）`);
      if (/^\s*(~|null|Null|NULL)\s*insert\s*:/.test(line)) yamlProblems.push(`第 ${i + 1} 行 "${line.trim()}" —— ~ 是 YAML null 字面量，应为 "- insert:"（#1724）`);
      else if (/^\s*-\s*insert(\s|$)/.test(line) && !/^\s*-\s*insert\s*:/.test(line)) yamlProblems.push(`第 ${i + 1} 行 "${line.trim()}" —— "- insert" 缺冒号`);
      if (!/^\s/.test(line)) {
        if (/^[^\s#-][^:]*:\s/.test(line)) hasTopMapping = true;
        if (/^-\s/.test(line)) hasTopSeq = true;
      }
    });
    if (hasTopMapping && hasTopSeq) yamlProblems.push("顶层同时存在 key: value 映射与 - xxx 序列（js-yaml 报 \"stream or a document separator is expected\"，#1724 实测）");
  }
  if (yamlProblems.length) report(ctx, "profile", "P7", false, `cordis.patch.yml 结构错误（boot 会崩，UI 打不开 #1724）: ${yamlProblems.join("; ")}`, "patch 必须是顶层纯列表（只有 - insert: / - id: 条目）：删掉顶层 key: value 行；~ 是 YAML null；缩进用空格不用 tab");
  else report(ctx, "profile", "P7", true, "cordis.patch.yml 结构正常（无 tab / 无 ~ insert / 无映射-序列混排）", undefined);

  // P8/P9/P10/P11/P13/P14 需要扫描 bundle 构建产物
  const bundleDirs = new Map();
  for (const b of bundles) { const d = findPkg(b); if (d) bundleDirs.set(b, d); }
  const collectJsFiles = (root, maxDepth = 3) => {
    const out = [];
    const walk = (dir, depth) => {
      if (depth > maxDepth) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        if (e.isDirectory() && (e.name === "client" || e.name === "web")) continue;
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) walk(fp, depth + 1);
        else if (e.name.endsWith(".js") && e.name !== "cordis.patch.yml") out.push(fp);
      }
    };
    walk(root, 0);
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
      if (typeof pkg.main === "string" && pkg.main.endsWith(".js")) {
        const mp = path.join(root, pkg.main);
        if (exists(mp) && !out.includes(mp)) out.push(mp);
      }
    } catch { /* 无 manifest */ }
    return out;
  };
  const readJs = (fp) => { try { return fs.readFileSync(fp, "utf8"); } catch { return ""; } };

  // P8：adapter provider 注册冲突（#1904②）
  const providerRegs = new Map();
  for (const [b, d] of bundleDirs) {
    for (const f of collectJsFiles(d)) {
      const src = readJs(f);
      for (const m of src.matchAll(/registerAdapter\s*\(\s*\[([^\]]*)\]/g)) {
        for (const pm of m[1].matchAll(/['"]([^'"]+)['"]/g)) {
          if (!providerRegs.has(pm[1])) providerRegs.set(pm[1], new Set());
          providerRegs.get(pm[1]).add(b);
        }
      }
    }
  }
  const adapterConflicts = [...providerRegs].filter(([, v]) => v.size > 1);
  if (adapterConflicts.length) report(ctx, "profile", "P8", false, `adapter provider 注册冲突（#1904②：boot 时 DUPLICATE_ADAPTER 崩溃）: ${adapterConflicts.map(([p, v]) => `${p}（${[...v].join(" ↔ ")}）`).join("; ")}`, "冲突 provider 只能注册一次：让第三方路由插件用 registerConfigurableProviders 或只注册新路由，移除抢注一方");
  else report(ctx, "profile", "P8", true, "无 adapter provider 注册冲突", undefined);

  const bundleInjectDecls = (all) => {
    const declared = [];
    for (const m of all.matchAll(/inject\s*=\s*\[([^\]]*)\]/gs)) declared.push(...[...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]));
    for (const m of all.matchAll(/ctx\.inject\s*\(\s*\[([^\]]*)\]/g)) declared.push(...[...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]));
    return declared.filter((v, i) => declared.indexOf(v) === i);
  };

  // P9：ctx.settings 未声明 settings 依赖（#1904⑤）
  const injectIssues = [];
  for (const [b, d] of bundleDirs) {
    const files = collectJsFiles(d);
    const all = files.map(readJs).join("\n");
    const usesSettings = /(?<![A-Za-z0-9_$])ctx\.(?:get\(\s*['"]settings['"]\s*\)|settings\b)/.test(all);
    if (!usesSettings) continue;
    const uniq = bundleInjectDecls(all);
    if (!uniq.includes("settings")) injectIssues.push(`${b}（用 ctx.settings 但 settings 依赖未声明${uniq.length ? `，全部 inject: [${uniq.join(", ")}]` : "，未找到任何 inject 声明"}）`);
  }
  if (injectIssues.length) report(ctx, "profile", "P9", false, `插件用 ctx.settings 但未声明 settings 依赖（#1904⑤：激活时 settings 可能未就绪 → namespace not registered）: ${injectIssues.join("; ")}`, "在插件代码加 export const inject = [\"settings\"]（或对可选服务做 undefined 处理）");
  else report(ctx, "profile", "P9", true, "bundle 的 ctx.settings 用法均声明了 settings 依赖（模块 inject 或 ctx.inject）", undefined);

  // P10：inject 引用客户端专属服务（#1947）
  const clientInjectIssues = [];
  for (const [b, d] of bundleDirs) {
    const all = collectJsFiles(d).map(readJs).join("\n");
    const clientDeps = bundleInjectDecls(all).filter((n) => /^(@deepseek-ai\/)?dsh-client-/.test(n));
    if (clientDeps.length) clientInjectIssues.push(`${b}（inject 引用客户端专属服务: ${clientDeps.join(", ")}）`);
  }
  if (clientInjectIssues.length) report(ctx, "profile", "P10", false, `插件 inject 引用客户端专属服务（服务端 cordis 树永不提供 → Fiber 永久 PENDING → web boot 失败，#1947）: ${clientInjectIssues.join("; ")}`, "客户端服务不能作为服务端插件依赖：把相关功能移到插件 client 半（package.json 的 dsh.client.inject），或删除该 inject");
  else report(ctx, "profile", "P10", true, "无客户端专属服务注入", undefined);

  // P11：已装 bundle 的 main 入口产物缺失（#1965）
  const entryIssues = [];
  for (const [b, d] of bundleDirs) {
    let main;
    try { main = JSON.parse(fs.readFileSync(path.join(d, "package.json"), "utf8")).main; } catch { continue; }
    if (typeof main !== "string" || !main.endsWith(".js")) continue;
    if (!exists(path.join(d, main))) entryIssues.push(`${b}（main=${main} 但产物缺失——未构建的源码树，或装错了仓库根而非 monorepo 子包）`);
  }
  if (entryIssues.length) report(ctx, "profile", "P11", false, `已装 bundle 的 main 入口缺失（#1965：市场装源码不跑构建 → ERR_MODULE_NOT_FOUND → dsh web boot 崩溃）: ${entryIssues.join("; ")}`, "在插件目录跑构建（pnpm install && pnpm run build 产出 main 指向的文件），或改用打包好的 npm 包安装；monorepo 插件需装子包（dsh-market #18 同族）");
  else report(ctx, "profile", "P11", true, "已装 bundle 的 main 入口产物均在", undefined);

  // P13：client 端服务名抢注（#2752）
  const coreClientServices = new Set(["chatFileMentions", "connection", "sessions", "workspaces", "modules", "locale"]);
  const collectProvideNames = (fp) => {
    let src;
    try { src = fs.readFileSync(fp, "utf8"); } catch { return []; }
    const out = [];
    for (const m of src.matchAll(/\.provide\(\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
    return out;
  };
  const collectClientJsFiles = (root) => {
    const out = [];
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
      const entry = pkg.dsh?.client;
      if (typeof entry === "string" && entry.endsWith(".js")) { const ep = path.join(root, entry); if (exists(ep)) out.push(ep); }
      else if (entry && typeof entry === "object" && typeof entry.entry === "string" && entry.entry.endsWith(".js")) { const ep = path.join(root, entry.entry); if (exists(ep)) out.push(ep); }
    } catch { /* 无 manifest */ }
    const walk = (dir, depth) => {
      if (depth > 3) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith(".") || e.name === "node_modules") continue;
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) walk(fp, depth + 1);
        else if (e.name.endsWith(".js")) out.push(fp);
      }
    };
    const cdir = path.join(root, "client");
    if (exists(cdir)) walk(cdir, 0);
    return [...new Set(out)];
  };
  if (installAnchor) {
    const coreScope = path.join(installAnchor, "@deepseek-ai");
    if (exists(coreScope)) {
      for (const p of fs.readdirSync(coreScope)) {
        if (!/^dsh-client-/.test(p)) continue;
        for (const f of collectClientJsFiles(path.join(coreScope, p))) for (const n of collectProvideNames(f)) coreClientServices.add(n);
      }
    }
  }
  const clientProvideMap = new Map();
  for (const [b, d] of bundleDirs) {
    for (const f of collectClientJsFiles(d)) {
      for (const n of collectProvideNames(f)) {
        if (!clientProvideMap.has(n)) clientProvideMap.set(n, new Set());
        clientProvideMap.get(n).add(b);
      }
    }
  }
  const coreHits = [...clientProvideMap].filter(([n]) => coreClientServices.has(n));
  const dupHits = [...clientProvideMap].filter(([, v]) => v.size > 1);
  const p13Issues = [];
  for (const [n, bs] of coreHits) p13Issues.push(`服务名 ${n} ∈ 核心客户端服务（${[...bs].join(", ")} 抢注 → 浏览器端 service already registered，UI 白屏 #2752）`);
  for (const [n, bs] of dupHits) if (!coreClientServices.has(n)) p13Issues.push(`服务名 ${n} 被多个插件 client 同时提供（${[...bs].join(", ")} → 同名注册冲突，加载期崩）`);
  if (p13Issues.length) report(ctx, "profile", "P13", false, `client 端服务名冲突（#2752：浏览器端 provide 撞核心服务 → UI 白屏且服务端日志无感知）: ${p13Issues.join("; ")}`, "改名自有 client 服务（避开核心 dsh-client-* 已注册名），或让冲突双方协商唯一命名；冲突在应用侧降级为局部警告前仍需避名");
  else report(ctx, "profile", "P13", true, "client 端 provide 服务名无冲突（未撞核心客户端服务、无跨 bundle 同名抢注）", undefined);

  // P14：declared bin 可执行性（#1846）
  const binIssues = [];
  for (const [b, d] of bundleDirs) {
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(path.join(d, "package.json"), "utf8")); } catch { continue; }
    const bin = pkg.bin;
    if (!bin) continue;
    const bins = typeof bin === "string" ? { [b.split("/").pop()]: bin } : bin;
    for (const [binName, rel] of Object.entries(bins)) {
      if (typeof rel !== "string") continue;
      const fp = path.join(d, rel);
      if (!exists(fp)) { binIssues.push(`${b}: bin 声明 ${binName} → ${rel} 但产物缺失（发布后 pnpm dlx/直接执行会失败）`); continue; }
      let head;
      try { head = fs.readFileSync(fp, "utf8").slice(0, 2); } catch { head = ""; }
      if (head !== "#!") binIssues.push(`${b}: bin ${binName}（${rel}）无 shebang——文本 bin 无解释器声明，直接执行 ENOEXEC（#1846 同型，exec bit 不识别解释器）`);
    }
  }
  if (binIssues.length) report(ctx, "profile", "P14", false, `declared bin 不可执行（#1846：安装/注册全过但 bin 跑不起来）: ${binIssues.join("; ")}`, "给 bin 入口补 `#!/usr/bin/env node`（或 chmod +x）；发布前用打包产物实测 `pnpm dlx <pkg>` / 直接执行一次（dsh-testkit 可代为跑真实宿主）");
  else report(ctx, "profile", "P14", true, "declared bin 均在（存在 + shebang/可执行位）", undefined);

  // installed_bundle（#1719 v1.1）：profile 内 bundle 版本 vs 运行端口版本
  try {
    const selfName = "@moonquake2004/dsh-doctor";
    const listed = Object.keys(deps).some((k) => k === selfName || k === "dsh-doctor");
    let bundlePkg = null;
    for (const cand of [selfName, "dsh-doctor"]) {
      const p = path.join(dir, "node_modules", cand, "package.json");
      if (exists(p)) { bundlePkg = p; break; }
    }
    if (!listed && !bundlePkg) {
      reportSkip(ctx, "profile", "installed_bundle", "profile 未声明也未安装 dsh-doctor bundle——无对比对象（本端口独立运行于 dsh_manager），skip 而非 pass（#1719 installed_bundle 合稿，sjh9714：pass 会让 CI 误判\"已同步\"）");
    } else if (listed && !bundlePkg) {
      report(ctx, "profile", "installed_bundle", false, `profile 的 package.json 声明了 ${selfName} 依赖，但 node_modules 里没有对应包（manifest 与运行时不一致，web 面板/API 实际加载不到）`, `dsh plugin --profile ${name} install ${selfName}（或先移除该依赖再重装）`);
    } else {
      const bundleVersion = JSON.parse(fs.readFileSync(bundlePkg, "utf8")).version;
      const cliVersion = PORTED_VERSION;
      const same = bundleVersion === cliVersion;
      report(ctx, "profile", "installed_bundle", same,
        same ? `profile 内 bundle 版本 ${bundleVersion} 与运行 CLI ${cliVersion} 一致` : `profile 内 bundle 版本 ${bundleVersion} ≠ 运行 CLI ${cliVersion}（web 面板/API 跑的是 bundle，两边行为可能不一致；若刚发布过新版本，升级可能被 pnpm-workspace.yaml 的 minimumReleaseAgeExclude 年龄门暂缓，可次日重试）`,
        same ? undefined : `同步安装版本：dsh plugin --profile ${name} update ${selfName}（或让 CLI 与 bundle 走同一安装方式）`);
    }
  } catch (e) {
	    report(ctx, "profile", "installed_bundle", false, `bundle 版本对比异常: ${e.message.slice(0, 60)}`, undefined);
	  }

	  // P15：关键文件 BOM 检测（#5176：package.json 被意外加 BOM 头导致 JSON 解析失败）
	  // UTF-8 BOM = EF BB BF = '\uFEFF'，pnpm/node 解析 JSON 时不认识 BOM → 报错
	  const bomTargets = [
	    path.join(dir, "package.json"),
	    path.join(dir, "cordis.patch.yml"),
	    path.join(dir, "settings.yaml"),
	  ];
	  const configDir = path.join(dir, "config");
	  if (exists(configDir)) {
	    try {
	      for (const f of fs.readdirSync(configDir)) {
	        if (f.endsWith(".json")) bomTargets.push(path.join(configDir, f));
	      }
	    } catch { /* skip */ }
	  }
	  const bomFiles = [];
	  for (const f of bomTargets) {
	    if (!exists(f)) continue;
	    try {
	      const head = fs.readFileSync(f, "utf8").slice(0, 1);
	      if (head === "\uFEFF") bomFiles.push(f.replace(dir + path.sep, ""));
	    } catch { /* skip */ }
	  }
	  if (bomFiles.length > 0) {
	    report(ctx, "profile", "P15", false, `检测到 BOM 头（#5176：JSON/YAML 解析将失败）: ${bomFiles.join(", ")}`, '用文本编辑器打开文件，删除首字符（BOM/U+FEFF）后保存；或运行: sed -i "" "1s/^\xEF\xBB\xBF//" <file>');
	  } else {
	    report(ctx, "profile", "P15", true, "关键文件无 BOM 头", undefined);
	  }
	}

	/* ================= session 检查 ================= */

function checkSession(ctx, target) {
  const targetPath = target || (() => {
    let best = null, bestM = -1;
    const root = path.join(ctx.home, "sessions");
    if (!exists(root)) return null;
    for (const u of fs.readdirSync(root)) {
      const sd = path.join(root, u);
      if (!exists(sd)) continue;
      for (const s of fs.readdirSync(sd)) {
        const f = exists(path.join(sd, s, "session.jsonl.zstd")) ? path.join(sd, s, "session.jsonl.zstd") : path.join(sd, s, "session.jsonl");
        if (!exists(f)) continue;
        const m = fs.statSync(f).mtimeMs;
        if (m > bestM) { bestM = m; best = f; }
      }
    }
    return best;
  })();
  if (!targetPath || !exists(targetPath)) { report(ctx, "session", "S0", true, "无会话日志，跳过单会话检查（可用 --session <path> 指定）", undefined); return; }
  let text;
  try {
    text = targetPath.endsWith(".zstd") ? execFileSync("zstd", ["-dc", targetPath], { maxBuffer: 512 * 1024 * 1024 }).toString("utf8") : fs.readFileSync(targetPath, "utf8");
  } catch (e) { report(ctx, "session", "S0", false, `解压失败: ${e.message.slice(0, 80)}`); return; }

  // S9 zstd 容器结构
  if (targetPath.endsWith(".zstd")) {
    try {
      const raw = fs.readFileSync(targetPath);
      const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
      let frames = 0;
      for (let i = 0; i <= raw.length - 4; i++) if (raw[i] === magic[0] && raw[i + 1] === magic[1] && raw[i + 2] === magic[2] && raw[i + 3] === magic[3]) frames++;
      if (frames === 0) report(ctx, "session", "S9", false, "不是有效的 zstd 容器（无帧 magic）", "该日志无法被 harness 读取");
      else if (frames === 1) report(ctx, "session", "S9", false, `单帧 zstd 容器（#1043：session.list 会整体 500，侧边栏全部消失）: ${frames} 帧`, "用多帧容器重写（正常日志每写批一帧），或删除该会话");
      else report(ctx, "session", "S9", true, `zstd 多帧容器正常（${frames} 帧）`, undefined);
    } catch (e) { report(ctx, "session", "S9", false, `帧扫描失败: ${e.message.slice(0, 60)}`); }
  } else {
    report(ctx, "session", "S9", true, "非 zstd 输入，跳过容器检查", undefined);
  }

  const KNOWN = knownSessionEventTypes();
  const calls = new Map(); const results2 = new Set(); let maxSeq = -1;
  const turnStarts = new Set(); const turnEnds = new Set();
  const positions = []; const endSeedSeqs = [];
  const expanded = []; const sesViolations = []; const s8Violations = []; let evIndex = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const seq = d.seq; if (typeof seq === "number" && seq > maxSeq) maxSeq = seq;
    if (!STORAGE_ROW_TYPES.has(d.type) && !KNOWN.has(d.type) && d.ignorable !== true) {
      s8Violations.push(`"${d.type}"`);
    }
    const t = d.type;
    if (t === "text-chunks" || t === "reasoning-chunks" || t === "tool-call-chunks") {
      const members = (d.data ?? {})[t === "tool-call-chunks" ? "args" : "texts"];
      const base = typeof d.seq0 === "number" ? d.seq0 : -1;
      for (let k = 0; k < (members?.length ?? 0); k++) {
        const eseq = base + k;
        expanded.push(eseq);
        if (eseq !== evIndex) sesViolations.push(`seq 空洞/重复 @${eseq}（期望 ${evIndex}）`);
        evIndex++;
      }
    } else if (typeof seq === "number") {
      expanded.push(seq);
      if (seq !== evIndex) sesViolations.push(`seq 空洞/重复 @${seq}（期望 ${evIndex}）`);
      evIndex++;
    }
    if (typeof seq === "number" && Array.isArray(d.sourceEventSeqs)) {
      for (const ref of d.sourceEventSeqs) {
        if (typeof ref === "number" && ref >= seq) sesViolations.push(`sourceEventSeqs 引用 ${ref} >= 当前 seq ${seq}（${t}）`);
      }
    }
    const pos = typeof seq === "number" ? seq : (typeof d.seq0 === "number" ? d.seq0 : null);
    if (pos !== null) positions.push({ pos, type: d.type, seq: seq ?? null });
    if (d.type === "session/end-seed" && typeof seq === "number") endSeedSeqs.push(seq);
    if (typeof d.turn === "number") { if (d.type === "turn/start") turnStarts.add(d.turn); if (d.type === "turn/end") turnEnds.add(d.turn); }
    const msg = d.data?.message;
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const blk of msg.content) {
      if (!blk || typeof blk !== "object") continue;
      if (blk.type === "tool-call" && typeof blk.id === "string") calls.set(blk.id, { seq: d.seq, name: blk.name });
      else if (blk.type === "tool-result" && typeof blk.toolCallId === "string") results2.add(blk.toolCallId);
    }
  }
  const orphans = [...calls].filter(([id]) => !results2.has(id)).map(([id, v]) => ({ id, ...v }));
  const real = orphans.filter((o) => typeof o.seq === "number" && o.seq < maxSeq - 1);
  const inflight = orphans.filter((o) => !real.includes(o));
  if (real.length) report(ctx, "session", "S1", false, `孤儿 tool_call（#1363，会 INVALID_REQUEST）: ${real.map((o) => o.id).join(", ")}`, "该会话历史不完整，建议新建会话");
  else report(ctx, "session", "S1", true, inflight.length ? `无真孤儿（仅尾部 in-flight: ${inflight.length} 个）` : "无孤儿 tool_call", undefined);
  const unclosed = [...turnStarts].filter((t) => !turnEnds.has(t));
  const realUnclosed = unclosed.filter((t) => t < Math.max(...turnStarts));
  const tailUnclosed = unclosed.filter((t) => !realUnclosed.includes(t));
  if (realUnclosed.length) report(ctx, "session", "S2", false, `未闭合 turn（#466/#1265，会话可能卡"运行中"）: ${realUnclosed.join(", ")}`, "重启 host 或删除该会话的残留状态");
  else report(ctx, "session", "S2", true, tailUnclosed.length ? `无历史未闭合 turn（尾部当前 turn 正常: ${tailUnclosed.join(", ")}）` : "所有 turn 均已闭合", undefined);

  const s6Violations = sesViolations.filter((v) => !v.startsWith("sourceEventSeqs"));
  if (s6Violations.length) report(ctx, "session", "S6", false, `seq 不连续/空洞/重复（#1333/#1452/#1469）: ${s6Violations.slice(0, 5).join("; ")}${s6Violations.length > 5 ? ` 等 ${s6Violations.length} 处` : ""}`, "会话事件序列损坏（可能被强制压缩/并发写坏），建议用端种子恢复或新建会话");
  else report(ctx, "session", "S6", true, `seq==index 连续（展开 ${expanded.length} 个事件，max seq ${maxSeq}）`, undefined);

  const s10 = sesViolations.filter((v) => v.startsWith("sourceEventSeqs"));
  if (s10.length) report(ctx, "session", "S10", false, `sourceEventSeqs 悬空引用（#1469，history unavailable）: ${s10.slice(0, 5).join("; ")}${s10.length > 5 ? ` 等 ${s10.length} 处` : ""}`, "压缩写入路径未重映射溯源引用，需修复日志或回滚压缩");
  else report(ctx, "session", "S10", true, "sourceEventSeqs 均引用早于自身的事件", undefined);

  if (s8Violations.length) {
    const seen = [...new Set(s8Violations)].slice(0, 5).join(", ");
    report(ctx, "session", "S8", false, `未知事件类型且无 ignorable 标记（#1538，harness 将整包拒绝）: ${seen}${new Set(s8Violations).size > 5 ? ` 等 ${new Set(s8Violations).size} 种` : ""}`, "该日志由更新版本/外部插件写入，当前 harness 无法读取；升级 harness 或标记 ignorable");
  } else {
    report(ctx, "session", "S8", true, `所有事件类型均在 KNOWN_SESSION_EVENT_TYPES 内（${KNOWN.size} 种）`, undefined);
  }

  if (endSeedSeqs.length) {
    const lastSeed = endSeedSeqs[endSeedSeqs.length - 1];
    const lastSeedIdx = positions.map((p) => p.pos).lastIndexOf(lastSeed);
    const after = positions.slice(lastSeedIdx + 1);
    const replayed = after.filter((p) => p.pos < lastSeed);
    if (replayed.length) {
      const sample = replayed.slice(0, 5).map((p) => `${p.type}@${p.pos}`).join(", ");
      report(ctx, "session", "S7", false, `end-seed 后重放已提交尾部（#1497）: 种子末尾 seq=${lastSeed}，其后出现 ${replayed.length} 条更低 seq（${sample}...）`, "单进程异常退出重放，需丢弃 end-seed 后的重放段");
    } else report(ctx, "session", "S7", true, `end-seed（末次 seq=${lastSeed}）之后无重放（其后 ${after.length} 条记录 seq 均更高）`, undefined);
  } else report(ctx, "session", "S7", true, "日志中无 session/end-seed（未做尾部重放检查）", undefined);
}

/* S11：全会话扫描 */
function scanAllSessions(ctx) {
  const root = path.join(ctx.home, "sessions");
  if (!exists(root)) { report(ctx, "session", "S11", true, "无会话目录，跳过全会话扫描", undefined); return; }
  const KNOWN = knownSessionEventTypes();
  const files = [];
  for (const u of fs.readdirSync(root)) {
    const sd = path.join(root, u);
    if (!exists(sd)) continue;
    for (const s of fs.readdirSync(sd)) {
      const f = exists(path.join(sd, s, "session.jsonl.zstd")) ? path.join(sd, s, "session.jsonl.zstd") : path.join(sd, s, "session.jsonl");
      if (exists(f)) files.push(f);
    }
  }
  if (files.length === 0) { report(ctx, "session", "S11", true, "未发现会话日志", undefined); return; }
  const corrupt = []; const oversized = []; const clean = [];
  let totalDS = 0; let totalEvents = 0;
  for (const f of files) {
    const cs = fs.statSync(f).size;
    let raw, frames = 0;
    try {
      raw = fs.readFileSync(f);
      const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
      for (let i = 0; i <= raw.length - 4; i++) if (raw[i] === magic[0] && raw[i + 1] === magic[1] && raw[i + 2] === magic[2] && raw[i + 3] === magic[3]) frames++;
    } catch { corrupt.push({ id: path.basename(path.dirname(f)), problems: ["读取失败"] }); continue; }
    let text;
    try { text = f.endsWith(".zstd") ? execFileSync("zstd", ["-dc", f], { maxBuffer: 512 * 1024 * 1024 }).toString("utf8") : fs.readFileSync(f, "utf8"); }
    catch { corrupt.push({ id: path.basename(path.dirname(f)), problems: ["解压/读取失败"] }); continue; }
    const ds = Buffer.byteLength(text, "utf8");
    totalDS += ds;
    const problems = [];
    let evIndex = 0, lastSeed = -1, seedIdx = -1, posList = [];
    const lines = text.split("\n");
    for (let li = 0; li < lines.length; li++) {
      const ln = lines[li]; if (!ln.trim()) continue;
      let d; try { d = JSON.parse(ln); } catch { problems.push(`行 ${li + 1} 无法解析`); continue; }
      if (!STORAGE_ROW_TYPES.has(d.type) && !KNOWN.has(d.type) && d.ignorable !== true) problems.push(`未知类型 ${d.type}`);
      if (d.type === "session/end-seed" && typeof d.seq === "number") { lastSeed = d.seq; seedIdx = posList.length; }
      const t = d.type;
      if (t === "text-chunks" || t === "reasoning-chunks" || t === "tool-call-chunks") {
        const members = (d.data ?? {})[t === "tool-call-chunks" ? "args" : "texts"];
        const base = typeof d.seq0 === "number" ? d.seq0 : -1;
        for (let k = 0; k < (members?.length ?? 0); k++) {
          const eseq = base + k;
          if (eseq !== evIndex) problems.push(`seq 空洞 @${eseq}(期望 ${evIndex})`);
          posList.push(eseq); evIndex++;
        }
      } else if (typeof d.seq === "number") {
        if (d.seq !== evIndex) problems.push(`seq 空洞 @${d.seq}(期望 ${evIndex})`);
        posList.push(d.seq); evIndex++;
      }
    }
    if (lastSeed >= 0) {
      const after = posList.slice(seedIdx + 1);
      if (after.some((p) => p < lastSeed)) problems.push("end-seed 后重放已提交尾部");
    }
    const id = path.basename(path.dirname(f));
    totalEvents += evIndex;
    const entry = { id, csMB: (cs / 1048576).toFixed(1), dsMB: (ds / 1048576).toFixed(1), frames, events: evIndex, problems };
    if (problems.length) corrupt.push(entry);
    else if (ds > 10 * 1048576 || frames > 10000) oversized.push(entry);
    else clean.push(entry);
  }
  const quars = corrupt.map((c) => `${c.id}（${c.problems.slice(0, 3).join("; ")}）`);
  const totalMB = Math.round(totalDS / 1048576);
  const estHeapMB = Math.round(Math.max(totalEvents * 600, totalDS * 6) / 1048576);
  const heapLimit = Number(process.env.DSH_DOCTOR_HEAP_MB || 1024);
  const totalRisk = estHeapMB > heapLimit;
  if (quars.length) report(ctx, "session", "S11", false, `全会话扫描：${corrupt.length} 个损坏会话（#1550：冷打开会拖垮服务器）: ${quars.join(" | ")}`, `隔离：把这些会话目录移出 ${path.join(ctx.home, "sessions")}（如 mv 到备份目录）`);
  else if (oversized.length || totalRisk) {
    const parts = [];
    if (oversized.length) parts.push(`${oversized.length} 个超大会话: ${oversized.map((o) => `${o.id}(${o.dsMB}MB/${o.events}事件)`).join(" | ")}`);
    if (totalRisk) parts.push(`工作区估算物化堆 ~${estHeapMB}MB（估算= max(${totalEvents}事件×600B, ${totalMB}MB×6)，跨 ${files.length} 会话累积，#1550 场景；阈值 ${heapLimit}MB，可设 DSH_DOCTOR_HEAP_MB）`);
    report(ctx, "session", "S11", true, `⚠ 全会话扫描：${parts.join("；")}（未损坏，可接受或归档）`, "冷启动会明显变慢；必要时压缩/归档历史会话");
  } else report(ctx, "session", "S11", true, `全会话扫描：${clean.length} 个会话均健康（损坏 0 / 超大 0 / 估算物化堆 ${estHeapMB}MB）`, undefined);
}

/* ================= 远程检查目录（层 A） ================= */

function expandPath(tpl, ctx) {
  return String(tpl)
    .replace(/\{home\}/g, ctx.home)
    .replace(/\{profile\}/g, ctx.profileDir ?? "{profile}")
    .replace(/\{profileName\}/g, ctx.profile);
}
function validCatalog(data) {
  return !!data && data.schemaVersion === 1 && Array.isArray(data.checks);
}
function bundledCatalog() {
  try { return JSON.parse(JSON.stringify(BUNDLED_CATALOG)); } catch { return { schemaVersion: 1, checks: [] }; }
}

/** 拉取目录：新鲜缓存(≤TTL) → 远程(3s 超时) → 旧缓存 → 内置副本。 */
async function loadCatalog(ctx, { noRemote = false } = {}) {
  const bundled = bundledCatalog();
  let base;
  const hasFetch = typeof fetch === "function";
  if (noRemote || !hasFetch) {
    base = { checks: bundled.checks, source: "bundled" };
  } else {
    const cachePath = path.join(ctx.home, ".cache", "dsh-doctor", "checks.json");
    const readCache = () => { if (!exists(cachePath)) return null; try { const d = JSON.parse(fs.readFileSync(cachePath, "utf8")); return validCatalog(d) ? d : null; } catch { return null; } };
    try {
      const cached = readCache();
      if (cached && Date.now() - fs.statSync(cachePath).mtimeMs < CATALOG_TTL_MS) base = { checks: cached.checks, source: "cache" };
    } catch { /* fallback */ }
    if (!base) {
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 3000);
        const res = await fetch(REMOTE_CATALOG_URL, { signal: ac.signal });
        clearTimeout(timer);
        if (res && res.ok) {
          const data = await res.json();
          if (validCatalog(data)) {
            try { fs.mkdirSync(path.dirname(cachePath), { recursive: true }); fs.writeFileSync(cachePath, JSON.stringify(data, null, 2)); } catch { /* 缓存失败不影响本次 */ }
            base = { checks: data.checks, source: "remote" };
          }
        }
      } catch { /* 离线/超时 → fallback */ }
    }
    if (!base) {
      const stale = readCache();
      base = stale ? { checks: stale.checks, source: "cache-stale" } : { checks: bundled.checks, source: "bundled" };
    }
  }
  return base;
}

/** 执行一条目录检查（只读探测原语）。返回 { ok, detail } 或 { ok, skipped }。 */
function runCatalogCheck(check, ctx) {
  const probe = check.probe ?? {};
  const p = (tpl) => expandPath(tpl, ctx);
  switch (probe.type) {
    case "command-exists": {
      const found = findCommand(probe.cmd);
      return found ? { ok: true, detail: check.detailOk ?? `${probe.cmd} 在 PATH: ${found}` }
                   : { ok: false, detail: check.detailFail ?? `${probe.cmd} 不在 PATH` };
    }
    case "path-exists":
    case "path-is-dir":
    case "path-is-file": {
      const fp = p(probe.path);
      let ok = exists(fp);
      if (ok && probe.type === "path-is-dir") ok = fs.lstatSync(fp).isDirectory();
      if (ok && probe.type === "path-is-file") ok = fs.lstatSync(fp).isFile();
      return ok ? { ok: true, detail: check.detailOk ?? `${fp} 存在` }
                : { ok: false, detail: check.detailFail ?? `${fp} 不存在/类型不符` };
    }
    case "json-valid": {
      const fp = p(probe.path);
      if (!exists(fp)) return probe.required === false
        ? { ok: true, detail: check.detailOk ?? `${fp} 不存在（跳过）` }
        : { ok: false, detail: check.detailFail ?? `${fp} 缺失` };
      let utf8ok = true, jsonok = false;
      try { new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(fp)); } catch { utf8ok = false; }
      if (utf8ok) { try { JSON.parse(fs.readFileSync(fp, "utf8")); jsonok = true; } catch { /* 非法 JSON */ } }
      return jsonok ? { ok: true, detail: check.detailOk ?? `${fp} 为合法 JSON` }
                    : { ok: false, detail: check.detailFail ?? `${fp} 不是合法 JSON（UTF-8:${utf8ok ? "OK" : "BAD"}）` };
    }
    case "text-contains":
    case "text-not-contains": {
      const fp = p(probe.path);
      if (!exists(fp)) return probe.required === false
        ? { ok: true, detail: check.detailOk ?? `${fp} 不存在（跳过）` }
        : { ok: false, detail: check.detailFail ?? `${fp} 缺失` };
      let re;
      try { re = new RegExp(probe.pattern, probe.flags ?? ""); } catch (e) { return { ok: false, detail: `目录规则正则非法: ${e.message.slice(0, 60)}` }; }
      const hit = re.test(fs.readFileSync(fp, "utf8"));
      const want = probe.type === "text-contains";
      return hit === want ? { ok: true, detail: check.detailOk ?? `${fp} ${want ? "匹配" : "未匹配"} ${probe.pattern}` }
                          : { ok: false, detail: check.detailFail ?? `${fp} ${want ? "未匹配" : "意外匹配"} ${probe.pattern}` };
    }
    case "file-size-above": {
      const fp = p(probe.path);
      if (!exists(fp)) return probe.required === true
        ? { ok: false, detail: check.detailFail ?? `${fp} 缺失` }
        : { ok: true, detail: check.detailOk ?? `${fp} 不存在（跳过）` };
      const size = fs.statSync(fp).size;
      return size > probe.minBytes
        ? { ok: false, detail: check.detailFail ?? `${fp} 过大: ${size}B > ${probe.minBytes}B` }
        : { ok: true, detail: check.detailOk ?? `${fp} 大小 ${size}B 在限内` };
    }
    case "glob-count": {
      const base = p(probe.base ?? probe.path);
      const count = globCount(base, probe.pattern);
      const min = probe.min ?? 1;
      const max = probe.max ?? Infinity;
      if (count < min) return { ok: false, detail: check.detailFail ?? `${probe.pattern} 匹配 ${count} 个（< ${min}）` };
      if (count > max) return { ok: false, detail: check.detailFail ?? `${probe.pattern} 匹配 ${count} 个（> ${max}）` };
      return { ok: true, detail: check.detailOk ?? `${probe.pattern} 匹配 ${count} 个（${min}..${max}）` };
    }
    case "file-writable": {
      const fp = p(probe.path);
      if (!exists(fp)) return probe.required === false
        ? { ok: true, detail: check.detailOk ?? `${fp} 不存在（跳过）` }
        : { ok: false, detail: check.detailFail ?? `${fp} 缺失` };
      let writable = false;
      try { const fd = fs.openSync(fp, "a"); fs.closeSync(fd); writable = true; } catch { /* 只读/属主问题 */ }
      return writable ? { ok: true, detail: check.detailOk ?? `${fp} 可写` }
                      : { ok: false, detail: check.detailFail ?? `${fp} 不可写（sudo 属主或只读权限，#1719）` };
    }
    default:
      return { ok: true, skipped: true, detail: `探测原语 ${probe.type} 本引擎不支持，已跳过（需更新插件）` };
  }
}

function checkCatalog(ctx, catalog) {
  const platform = process.platform;
  for (const check of catalog.checks ?? []) {
    const when = check.when ?? {};
    if (Array.isArray(when.os) && !when.os.includes(platform)) continue;
    if (check.section === "profile" && !ctx.profileDir) continue;
    let r;
    try { r = runCatalogCheck(check, ctx); } catch (e) { r = { ok: false, detail: `catalog 检查异常: ${e.message.slice(0, 80)}` }; }
    if (r.skipped) { report(ctx, check.section, check.id, true, r.detail, undefined, { src: "catalog" }); continue; }
    ctx.catalogSeverity.set(check.id, check.severity ?? "error");
    report(ctx, check.section, check.id, r.ok, r.detail, r.ok ? undefined : check.fix, { src: "catalog", severity: check.severity });
  }
}

/* ================= 层 B：上游版本提示 ================= */

function checkForUpdate(ctx, { noRemote = false } = {}) {
  const current = PORTED_VERSION;
  const hasFetch = typeof fetch === "function";
  if (noRemote || !hasFetch) return Promise.resolve({ current, latest: null, available: false });
  const cachePath = path.join(ctx.home, ".cache", "dsh-doctor", "update.json");
  const readCache = () => { try { const d = JSON.parse(fs.readFileSync(cachePath, "utf8")); return d && typeof d.latest === "string" ? d : null; } catch { return null; } };
  return (async () => {
    try {
      const c = readCache();
      if (c && Date.now() - fs.statSync(cachePath).mtimeMs < UPDATE_TTL_MS) return { current, latest: c.latest, available: c.latest !== current };
    } catch { /* fallback */ }
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 3000);
      const res = await fetch(UPDATE_URL, { signal: ac.signal });
      clearTimeout(timer);
      if (res && res.ok) {
        const data = await res.json();
        const latest = data?.["dist-tags"]?.latest;
        if (typeof latest === "string") {
          try { fs.mkdirSync(path.dirname(cachePath), { recursive: true }); fs.writeFileSync(cachePath, JSON.stringify({ latest, checkedAt: new Date().toISOString() })); } catch { /* 缓存失败不影响 */ }
          return { current, latest, available: latest !== current };
        }
      }
    } catch { /* 离线/超时 → last-known-good */ }
    const stale = readCache();
    if (stale) return { current, latest: stale.latest, available: stale.latest !== current };
    return { current, latest: null, available: false };
  })();
}

/* ================= 主流程 ================= */

function buildContext(opts = {}) {
  const dshHome = opts.dshHome || opts.home || process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  const home = path.resolve(dshHome);
  const envFile = path.join(home, ".env");
  let profileDir = null;
  try { profileDir = resolveProfile(home, opts.profile || "web"); } catch { /* 无效 profile */ }
  return {
    ...opts,
    home,
    profile: opts.profile || "web",
    profileDir,
    envFile,
    results: [],
    catalogSeverity: new Map(catalogSeveritySeed),
    only: null,
  };
}

/** 运行完整引擎，返回 { results, catalog:meta, update:meta }。只读，不写用户数据。 */
async function runChecks(ctx) {
  ctx.results = [];
  ctx.catalogSeverity = new Map(catalogSeveritySeed);
  const profile = ctx.profile || "web";
  let catalogMeta = { source: "none", checks: 0 };
  let update = { current: PORTED_VERSION, latest: null, available: false };

  try { checkEnv(ctx); } catch (e) { report(ctx, "env", "E0", false, `env 检查异常: ${e.message.slice(0, 80)}`); }
  try { await checkPort3080(ctx); } catch (e) { report(ctx, "env", "E10-port-3080", false, `端口检查异常: ${e.message.slice(0, 60)}`); }
  try { checkProfile(ctx, profile); } catch (e) { report(ctx, "profile", "P0", false, `profile 检查异常: ${e.message.slice(0, 100)}`); }
  try { checkSession(ctx); } catch (e) { report(ctx, "session", "S0", false, `session 检查异常: ${e.message.slice(0, 100)}`); }
  try { scanAllSessions(ctx); } catch (e) { report(ctx, "session", "S11", false, `全会话扫描异常: ${e.message.slice(0, 100)}`); }

  // 远程目录（层 A）
  try {
    const catalog = await loadCatalog(ctx, { noRemote: ctx.noRemote });
    catalogMeta = { source: catalog.source, checks: catalog.checks.length };
    if (catalog.checks.length && ctx.profileDir) checkCatalog(ctx, { ...catalog });
    else if (catalog.checks.length) report(ctx, "catalog", "C0", true, `profile 无效（${profile}），目录检查跳过（${catalog.source}）`, undefined, { src: "catalog" });
  } catch (e) {
    catalogMeta = { source: "error", checks: 0, error: e.message.slice(0, 80) };
  }

  // 层 B：上游版本提示（不自动更新；仅供 dsh_manager 旁观 dsh-doctor 上游进度）
  try {
    update = await checkForUpdate(ctx, { noRemote: ctx.noRemote });
  } catch { update = { current: PORTED_VERSION, latest: null, available: false }; }

  return { results: ctx.results, catalog: catalogMeta, update };
}

/* -------- findings 转换（前端契约） -------- */

const SECTION_TITLES = {
  env: "环境", profile: "Profile", session: "会话", catalog: "检查目录",
};
const LEVEL_MAP = { env: "install", catalog: "install", profile: "harness", session: "harness" };
const KNOWN_TITLES = {
  "E1-node": "node 在 PATH", "E1-pnpm": "pnpm 在 PATH", "E1-zstd": "zstd 在 PATH", "E2-env": ".env 类型",
  "E3-node": "node 版本", "E4": "node-pty 原生模块", "E5": "存储 JSON 合法性", "E6": "锚点元检查", "E10-port-3080": "Web 端口 3080",
  "P0": "Profile 可解析", "P1": "bundle 可解析性", "P2": "id 冲突", "P3": "insert name 可解析性", "P4": "file: 依赖",
  "P5": "顶层 @deepseek-ai 重复", "P7": "patch YAML 结构", "P8": "adapter provider 冲突", "P9": "settings 依赖声明",
  "P10": "客户端专属服务注入", "P11": "main 入口产物", "P13": "client 服务名冲突", "P14": "bin 可执行性", "P15": "文件 BOM 检测",
  "installed_bundle": "installed_bundle 版本",
  "S0": "会话可读", "S1": "孤儿 tool_call", "S2": "未闭合 turn", "S6": "seq 连续性", "S7": "end-seed 重放",
  "S9": "zstd 容器", "S10": "sourceEventSeqs", "S8": "未知事件类型", "S11": "全会话扫描",
  "E7-dsh-in-path": "dsh 在 PATH", "E8-npmrc-workspace-flag": ".npmrc 安装开关", "P6-patch-name-space": "patch name 空格",
  "E9-storages-json-valid": "config JSON 合法性", "E11-settings-writable": "settings 可写性",
};
function toFinding(ctx, r) {
  const warn = ctx.catalogSeverity.get(r.id) === "warn";
  const severity = r.skip ? "skip" : (r.ok ? "ok" : (warn ? "warn" : "error"));
  return {
    checkId: r.id,
    title: KNOWN_TITLES[r.id] || `${SECTION_TITLES[r.section] || r.section}:${r.id}`,
    level: LEVEL_MAP[r.section] || "harness",
    severity,
    message: r.detail,
    remediation: r.skip ? undefined : r.fix,
  };
}

/** 静态检查清单（供 checkList / CHECKS 导出）。 */
const CHECKS = [
  "E1-node", "E1-pnpm", "E1-zstd", "E2-env", "E3-node", "E4", "E5", "E6", "E10-port-3080",
  "P0", "P1", "P2", "P3", "P4", "P5", "P7", "P8", "P9", "P10", "P11", "P13", "P14", "P15", "installed_bundle",
  "S0", "S1", "S2", "S6", "S7", "S9", "S10", "S8", "S11",
  "E7-dsh-in-path", "E8-npmrc-workspace-flag", "P6-patch-name-space", "E9-storages-json-valid", "E11-settings-writable",
].map((id) => ({ id, title: KNOWN_TITLES[id] || id, level: LEVEL_MAP[id.split("-")[0].split("/")[0]] || "harness" }));

/** 运行诊断并返回前端契约报告。ctx 应来自 buildContext(); only 可选，过滤 checkId。 */
async function buildReport(ctx, only) {
  if (!ctx || !ctx.home) throw new Error("buildReport 需要 buildContext() 产生的 ctx");
  ctx.only = only && only.length ? only : null;
  const { results, catalog, update } = await runChecks(ctx);
  const findings = [];
  for (const r of results) {
    if (ctx.only && !ctx.only.includes(r.id)) continue;
    findings.push(toFinding(ctx, r));
  }
  const summary = { ok: 0, warn: 0, error: 0, skip: 0 };
  for (const f of findings) if (summary[f.severity] !== undefined) summary[f.severity] += 1;
  return {
    version: `dsh-doctor-v${PORTED_VERSION}（${PORTED_SOURCE}）`,
    findings,
    summary,
    healthy: summary.error === 0,
    checks: CHECKS,
    meta: { catalog, update },
  };
}

module.exports = { run, buildContext, buildReport, CHECKS };

/* =====================================================================
 * MIT License（本文件主体引擎改写自 moonquake2004/dsh-doctor）
 * Copyright (c) 2026 moonquake2004
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 * ===================================================================== */