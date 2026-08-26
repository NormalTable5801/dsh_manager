"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const S = {
  status: null,
  versions: [],          // 版本列表 [{tag,v}]
  updateInfo: null,
  hasRemote: false,
  currentVersion: "",
  latestTag: null,
  taskLines: [],         // 当前/最近一次任务日志
  taskName: "",
  busy: false,
  consoleRunning: false,
  consoleLines: [],
};

const fmtBytes = (n) => { if (!isFinite(n)) return "-"; const u = ["B","KB","MB","GB","TB"]; let i = 0, v = n; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return `${v.toFixed(v >= 100 ? 0 : 1)} ${u[i]}`; };
const fmtDate = (iso) => { if (!iso) return ""; const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString("zh-CN", { hour12: false }); };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------------- 请求工具 ---------------- */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data;
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败(${res.status})`);
  return data;
}

/* ---------------- 提示 / 确认 ---------------- */
function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 4200);
}
function confirmBox({ title = "确认", html, okLabel = "确认" }) {
  return new Promise((resolve) => {
    const ok = $("#modalOk"), cancel = $("#modalCancel");
    $("#modalTitle").textContent = title;
    $("#modalBody").innerHTML = html;
    $("#modal").classList.remove("hidden");
    const done = (v) => { $("#modal").classList.add("hidden"); ok.removeEventListener("click", onOk); cancel.removeEventListener("click", onCancel); resolve(v); };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    ok.textContent = okLabel;
  });
}
function setBusy(b, text) {
  S.busy = b;
  $("#busy").classList.toggle("hidden", !b);
  if (text) $("#busyText").textContent = text;
  setButtonsDisabled(b);
  if (!b && typeof syncWebButtons === "function") syncWebButtons();
  if (!b && typeof syncConsoleButtons === "function") syncConsoleButtons();
}
function setButtonsDisabled(b) {
  $$(".action-btn").forEach((btn) => { if (!btn.dataset.always) btn.disabled = b; });
}

/* ---------------- SSE ---------------- */
function connectSSE() {
  const es = new EventSource("/api/events");
  es.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === "task:start") { S.taskLines = []; S.taskName = m.task ? m.task.name : ""; setBusy(true, S.taskName + "…"); renderTaskLogs(); renderStatus(); }
    else if (m.type === "task:line") { S.taskLines.push(m.line.text); renderTaskLogs(); }
    else if (m.type === "task:end") { setBusy(false); refresh(); renderUpgradeBtn(); }
    else if (m.type === "web:change") { renderWeb(); }
    else if (m.type === "web:line") { appendWebLog(m.line); }
    else if (m.type === "console:start") { S.consoleRunning = true; S.consoleLines = []; const t = $("#consoleOut"); if (t) { t.innerHTML = ""; } appendConsoleLine("$ " + (m.cmd || ""), "input"); syncConsoleButtons(); }
    else if (m.type === "console:line") { S.consoleRunning = true; appendConsoleLine(m.line.text); }
    else if (m.type === "console:end") { S.consoleRunning = false; appendConsoleLine("[进程结束，退出码 " + m.code + "]", "muted"); syncConsoleButtons(); }
  };
  es.onerror = () => {
    const dot = $("#connDot");
    dot.textContent = "● 已断开，重连中…";
    dot.classList.add("off");
  };
}

/* ---------------- 状态渲染 ---------------- */
function renderStatus() {
  const st = S.status;
  if (!st) return;
  S.currentVersion = st.version || "?";
  S.hasRemote = st.remoteConfigured;
  $("#topVersion").textContent = "v" + S.currentVersion;
  renderStats(st);
  renderEnvStrip(st.env);
  renderWeb();
  if (isView("env")) renderEnv();
  if (isView("settings")) renderConfigForm();
  $("#homePath").textContent = " → " + st.home + (st.homeSize ? `（${fmtBytes(st.homeSize)}）` : "");
  if (isView("backups")) renderBackups(st.backups);
  if (isView("versions") && !S.versions.length) loadVersions(false);
  if (isView("update") && S.updateInfo === null) checkUpdate(false);
  renderGitState();
}

function renderStats(st) {
  const grid = $("#statGrid");
  const rec = (opts) => `<div class="stat"><div class="k">${opts.k}</div><div class="v ${opts.cls || ""}">${opts.v}</div>${opts.sub ? `<div class="sub">${opts.sub}</div>` : ""}</div>`;
  const web = st.web;
  grid.innerHTML =
    rec({ k: "Harness 版本", v: st.version || "?", sub: st.gitRef || "非 git 仓库" }) +
    rec({ k: "数据目录(~/.dsh)", v: fmtBytes(st.homeSize), sub: st.home }) +
    rec({ k: "dsh web 状态", v: web.running ? "运行中" : "已停止", cls: web.running ? "good" : "muted", sub: web.url || (web.externalOccupied ? "端口被外部占用" : "") }) +
    rec({ k: "仓库改动", v: st.dirty.count ? st.dirty.count + " 项" : "干净", cls: st.dirty.count ? "warn" : "good", sub: st.dirty.msg || "" }) +
    rec({ k: "配置了官方 remote", v: st.remoteConfigured ? "是" : "否", cls: st.remoteConfigured ? "good" : "bad", sub: "未配置则无法检查更新" }) +
    rec({ k: "构建工具链", v: st.env.nodeOk ? "就绪" : "告警", cls: st.env.nodeOk ? "good" : "bad", sub: st.env.nodeMessage || "" });
}

function envChip(name, val, good) {
  return `<span class="chip ${good ? "good" : val ? "bad" : "warn"}"><b>${name}</b> ${esc(val || "未检测到")}</span>`;
}
function renderEnvStrip(env) {
  const goodNode = env.nodeOk === null ? null : !!env.nodeOk;
  $("#envStrip").innerHTML =
    envChip("node", env.node, env.nodeOk) +
    envChip("pnpm", env.pnpm, !!env.pnpm) +
    envChip("git", String(env.git || "").replace(/^git version\s+/i, ""), !!env.git);
}

function renderWeb() {
  const st = S.status;
  if (!st) return;
  const web = st.web;
  const box = $("#launchStatus");
  const lines = [];
  if (web.running) {
    lines.push(`<div class="l">● 运行中    PID: ${web.pid}</div>`);
    lines.push(`<div class="l">启动时间: ${fmtDate(new Date(web.startedAt).toISOString())}</div>`);
    lines.push(`<div class="l">profile: ${esc(web.profile)}  模式: ${esc(web.mode)}  端口: ${web.configuredPort || "自动"}</div>`);
    lines.push(web.url ? `<div class="l ok">访问地址: <a style="color:var(--accent-2)" target="_blank" href="${web.url}">${web.url}</a></div>` : `<div class="l muted">尚未捕获到访问地址…</div>`);
  } else {
    lines.push(`<div class="l">● 已停止</div>`);
    if (web.externalOccupied) lines.push(`<div class="l warn">端口 ${web.configuredPort} 被其他进程占用，请检查</div>`);
  }
  box.innerHTML = lines.join("") || "—";
  $("#btnRestart").disabled = !web.running;
  syncWebButtons();
}

// 按 dsh web 运行状态禁用“启动/停止”按钮：运行中禁用启动，停止中禁用停止。
function syncWebButtons() {
  const st = S.status;
  const running = !!(st && st.web && st.web.running);
  document.querySelectorAll('[data-act="launch"]').forEach((b) => { b.disabled = running; });
  document.querySelectorAll('[data-act="stop"]').forEach((b) => { b.disabled = !running; });
}

function renderGitState() {
  const st = S.status;
  if (!st || !isView("env")) return;
  $("#gitState").innerHTML =
    `<div class="l">仓库: ${esc(st.repoPath)}</div>` +
    `<div class="l">Git 引用: ${esc(st.gitRef || "—")}</div>` +
    `<div class="l">版本: v${esc(st.version || "—")}</div>` +
    `<div class="l">改动: ${esc(st.dirty.msg || "无")}${st.dirty.count ? `（${st.dirty.count} 项）` : ""}</div>` +
    `<div class="l">官方 remote: ${st.remoteConfigured ? `已配置` : "未配置"}</div>`;
}

/* ---------------- 任务日志 ---------------- */
function renderTaskLogs() {
  const html = S.taskLines.length
    ? S.taskLines.map((l) => `<div class="${/ERROR|失败|error:/i.test(l) ? "err" : /完成|成功|done/i.test(l) ? "ok" : ""}">${esc(l)}</div>`).join("")
    : `<div class="terminal-empty">等待任务输出…</div>`;
  const alwaysScroll = (t) => { if (t) { t.innerHTML = html; t.scrollTop = t.scrollHeight; } };
  alwaysScroll($("#taskLog"));
  alwaysScroll($("#taskLogV"));
}

/* ---------------- web 日志 ---------------- */
function appendWebLog(line) {
  const term = $("#webLog");
  const empty = term.querySelector(".terminal-empty");
  if (empty) empty.remove();
  const div = document.createElement("div");
  div.textContent = line;
  term.appendChild(div);
  term.scrollTop = term.scrollHeight;
  if (term.childElementCount > 600) term.removeChild(term.firstElementChild);
}

/* ---------------- 版本 ---------------- */
async function loadVersions(fetchFirst) {
  try {
    if (fetchFirst) await api("/api/versions"); // 命中一次以拉本地标签
    const d = await api("/api/versions");
    renderVersions(d);
    if (S.status) { S.hasRemote = S.status.remoteConfigured; }
  } catch (e) { toast(e.message, "err"); }
}
function renderVersions(d) {
  S.versions = d.versions || [];
  const list = $("#versionList");
  if (!S.versions.length) { list.innerHTML = `<div class="muted">暂无版本标签。点击“拉取版本列表”从官方仓库抓取。</div>`; return; }
  const cur = d.current;
  const latest = S.versions[0];
  list.innerHTML = S.versions.map((v) => {
    const isCur = v.v === cur || v.tag === cur;
    const isLatest = latest && v.tag === latest.tag;
    return `<div class="vrow ${isCur ? "cur" : ""}">
      <div class="vtag">${esc(v.tag)}</div>
      <div class="vmeta">${isCur ? '<span class="cur-badge">当前版本</span>' : ""} ${isLatest && !isCur ? '<span class="latest-badge">最新</span>' : ""}</div>
      <div>
        ${isCur ? "" : `<button class="tag-btn" data-rollback="${esc(v.tag)}">回滚到此版</button>`}
        <span class="muted" style="font-size:11px">当前版 ${esc(cur)}</span>
      </div>
    </div>`;
  }).join("") || `<div class="muted">无版本</div>`;
  $("#rangeInfo").innerHTML = S.status ? `当前版本 v${esc(cur)}。切换到其他版本会执行 git checkout → pnpm install → pnpm build，并在操作前自动备份 <code>~/.dsh</code>。` : "";
}

/* ---------------- 更新检查 / 升级 ---------------- */
async function checkUpdate(silent) {
  $("#updateInfo").innerHTML = "正在拉取官方仓库并检测版本…";
  try {
    const d = await api("/api/updates/check");
    S.updateInfo = d;
    if (S.status) S.status.remoteConfigured = d.ok;
    const cur = d.current;
    renderVersions({ ...d, current: cur });
    const html = [];
    html.push(`<div class="l">当前版本: <b>v${esc(cur)}</b> &nbsp; 最新版本: <b>${d.latest ? esc(d.latest) : "—"}</b></div>`);
    if (!d.latest) html.push(`<div class="l muted">未获取到任何版本标签（请检查网络/remote）。</div>`);
    else if (d.hasUpdate) {
      html.push(`<div class="l warn">检测到可升级版本：${d.newer.slice(0, 5).map((x) => esc(x.tag)).join("、")} 等</div>`);
      $("#btnUpgrade").disabled = false;
    } else {
      html.push(`<div class="l ok">已是最新版本（或者更高，无需升级）。</div>`);
      $("#btnUpgrade").disabled = true;
    }
    html.push(`<div class="l muted" style="margin-top:6px">升级日志见下方。</div>`);
    $("#updateInfo").innerHTML = html.join("");
    if (!silent) toast(d.hasUpdate ? "发现新版本，可升级" : "已是最新", d.hasUpdate ? "" : "ok");
  } catch (e) {
    $("#updateInfo").innerHTML = `<div class="l err">检查更新失败：${esc(e.message)}</div>`;
    if (!silent) toast(e.message, "err");
  }
}

async function doUpgrade() {
  if (!S.updateInfo || !S.updateInfo.hasUpdate) return toast("请先检查更新", "err");
  const ok = await confirmBox({
    title: "升级 Harness",
    html: `将把 Harness 升级到最新版本 <b>${esc(S.updateInfo.latest)}</b>。<br/><br/>流程：<code>git fetch</code> → 切换到最新 tag → <code>pnpm install</code> → <code>pnpm build</code>。<br/><br/><i class="muted">操作前会自动备份数据目录。</i>`,
    okLabel: "开始升级",
  });
  if (!ok) return;
  setBusy(true, "正在升级…");
  try {
    const r = await api("/api/upgrade", { method: "POST", body: { autoBackup: true, target: S.updateInfo.latest } });
    toast("升级完成", "ok");
  } catch (e) { toast(e.message, "err"); } finally { refresh(); }
}

// 版本列表点击回滚
$("#versionList").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-rollback]");
  if (!btn) return;
  const tag = btn.dataset.rollback;
  const ok = await confirmBox({
    title: "回滚版本",
    html: `确定切换到版本 <b>${esc(tag)}</b> 吗？<br/><br/>这会在仓库内执行 <code>git checkout</code> + 重新构建。操作前会自动备份数据目录。<br/><br/><span class="warn-title">注意：</span> 这是破坏性操作，请确认仓库无未提交改动。`,
    okLabel: "切换到此版本",
  });
  if (!ok) return;
  setBusy(true, "回滚中…");
  try {
    await api("/api/rollback", { method: "POST", body: { tag, autoBackup: true } });
    toast("版本切换完成", "ok");
    S.updateInfo = null; $("#btnUpgrade").disabled = true;
  } catch (err) { toast(err.message, "err"); } finally { refresh(); }
});

/* ---------------- 备份 ---------------- */
function renderBackups(backups) {
  const tb = $("#backupRows");
  if (!backups || !backups.length) { tb.innerHTML = `<tr><td colspan="6" class="muted">暂无备份。点击“立即备份”把数据目录复制到本管理的 backups 目录。</td></tr>`; return; }
  tb.innerHTML = backups.map((b) => `<tr>
    <td style="font-family:var(--mono)">${esc(b.id)}</td>
    <td>${esc(fmtDate(b.created))}</td>
    <td>${b.version ? "v" + esc(b.version) : "—"}</td>
    <td>${fmtBytes(b.size)}</td>
    <td>${b.files}</td>
    <td>
      <button class="tag-btn" data-restore="${esc(b.id)}">还原</button>
      <button class="tag-btn danger" data-del="${esc(b.id)}">删除</button>
    </td>
  </tr>`).join("");
}
$("#backupRows").addEventListener("click", async (e) => {
  const t = e.target.closest("[data-restore],[data-del]");
  if (!t) return;
  const id = t.dataset.restore || t.dataset.del;
  if (t.dataset.del) {
    const ok = await confirmBox({ title: "删除备份", html: `确定删除备份 <b>${esc(id)}</b> 吗？此操作不可恢复。`, okLabel: "删除" });
    if (!ok) return;
    try { await api("/api/backup/delete", { method: "POST", body: { id } }); toast("已删除", "ok"); }
    catch (err) { toast(err.message, "err"); }
    refresh(); return;
  }
  const ok = await confirmBox({ title: "还原备份", html: `将用备份 <b>${esc(id)}</b> 覆盖当前数据目录。<br/><br/><span class="warn-title">这会覆盖现有对话和配置。</span><br/>还原前会先对当前数据做安全性备份。`, okLabel: "还原" });
  if (!ok) return;
  setBusy(true, "还原中…");
  try { await api("/api/backup/restore", { method: "POST", body: { id, safety: true } }); toast("还原完成", "ok"); }
  catch (err) { toast(err.message, "err"); }
  finally { refresh(); }
});

/* ---------------- 环境 / 设置 ---------------- */
function renderEnv() {
  const st = S.status;
  if (!st) return;
  const e = st.env;
  const card = (k, v, good) => `<div class="stat"><div class="k">${k}</div><div class="v ${good ? "good" : v ? "bad" : "muted"}">${esc(v || "未检测到")}</div></div>`;
  $("#envDetail").innerHTML =
    card("Node", e.node, e.nodeOk) +
    card("pnpm", e.pnpm, !!e.pnpm) +
    card("git", e.git, !!e.git) +
    (e.nodeMessage ? `<div class="stat" style="grid-column:1/-1"><div class="k">说明</div><div class="sub" style="white-space:pre-wrap">${esc(e.nodeMessage)}</div></div>` : "");
}
function renderConfigForm() {
  if (!S.status) return;
  const c = S.status.mixed;
  $("#cfgRepoPath").value = c.repoPath || "";
  $("#cfgDshHome").value = c.dshHome || "";
  $("#cfgPort").value = c.port;
  $("#cfgWebPort").value = c.webPort;
  $("#cfgLaunchMode").value = c.launchMode;
  $("#cfgLaunchProfile").value = c.launchProfile;
  $("#cfgRemote").value = c.officialRemote;
  $("#cfgAutoBackup").checked = c.autoBackupBeforeUpgrade;
  $("#cfgSafety").checked = c.safetyBackupBeforeRestore;
  $("#cfgMaxBackups").value = c.maxBackups;
}

/* ---------------- 诊断 Doctor ---------------- */
async function runDoctor(silent) {
  if (!silent) $("#doctorResult").innerHTML = '<div class="muted">正在运行诊断…</div>';
  try {
    const d = await api("/api/doctor");
    S.doctorLoaded = true;
    S.doctorRanAt = Date.now();
    renderDoctor(d);
  } catch (e) {
    $("#doctorResult").innerHTML = `<div class="err">诊断失败：${esc(e.message)}</div>`;
    if (!silent) toast(e.message, "err");
  }
}
function renderDoctor(d) {
  const sum = d.summary || { ok: 0, warn: 0, error: 0 };
  $("#doctorSummary").textContent = `✓ ${sum.ok} · ! ${sum.warn} · ✗ ${sum.error}`;
  $("#doctorSummary").className = "pill " + (sum.error ? "err" : sum.warn ? "warn" : "ok");
  const box = $("#doctorResult");
  box.innerHTML = (d.findings || []).map((f) => {
    const mark = f.severity === "ok" ? "✓" : f.severity === "warn" ? "!" : "✗";
    return `<div class="drow ${f.severity}">
      <div class="dline"><span class="dmark">${mark}</span><b>${esc(f.title)}</b> <span class="did">[${esc(f.checkId)}]</span><span class="dlev">${esc(f.level)}</span>${f.message ? ` — ${esc(f.message)}` : ""}</div>
      ${f.remediation ? `<div class="drem">fix: ${esc(f.remediation)}</div>` : ""}
      ${f.detail ? `<div class="ddetail">${esc(f.detail)}</div>` : ""}
    </div>`;
  }).join("") || '<div class="muted">无检查结果。</div>';
  if (S.doctorRanAt) $("#doctorResult").insertAdjacentHTML("beforeend", `<div class="muted" style="margin-top:8px">上次运行：${fmtDate(new Date(S.doctorRanAt).toISOString())}</div>`);
}
async function doctorFixSettings() {
  const ok = await confirmBox({ title: "修复 settings.yaml", html: "为空/损坏的 settings.yaml<b>先备份为 .doctor-bak</b> 再写入最小合法配置（非空则不动）。", okLabel: "修复" });
  if (!ok) return;
  try {
    const r = await api("/api/doctor/fix", { method: "POST", body: { target: "settings" } });
    toast((r.fix.applied ? "已修复：\u200b" : "跳过：") + r.fix.message, r.fix.applied ? "ok" : "");
  } catch (e) { toast(e.message, "err"); }
  runDoctor(true);
}
async function doctorFixKey() {
  const key = window.prompt("请输入 DEEPSEEK_API_KEY：\n（将去重写入 $DSH_HOME/.env，值不会在任何日志回显）");
  if (key === null) return;
  try {
    const r = await api("/api/doctor/fix", { method: "POST", body: { target: "credentials", value: key } });
    toast((r.fix.applied ? "已写入：\u200b" : "跳过：") + r.fix.message, r.fix.applied ? "ok" : "");
  } catch (e) { toast(e.message, "err"); }
  runDoctor(true);
}

/* ---------------- 控制台 Console ---------------- */
function appendConsoleLine(text, cls) {
  if (text == null) return;
  const term = $("#consoleOut");
  if (!term) return;
  const empty = term.querySelector(".terminal-empty");
  if (empty) empty.remove();
  const div = document.createElement("div");
  if (cls) div.className = cls;
  div.textContent = text;
  term.appendChild(div);
  term.scrollTop = term.scrollHeight;
  if (term.childElementCount > 2000) term.removeChild(term.firstElementChild);
  S.consoleLines.push(text);
  if (S.consoleLines.length > 2000) S.consoleLines = S.consoleLines.slice(-2000);
}
function renderConsoleHistory(lines) {
  const term = $("#consoleOut");
  if (!term) return;
  term.innerHTML = "";
  if (lines && lines.length) { for (const l of lines) { const d = document.createElement("div"); d.textContent = l; term.appendChild(d); } term.scrollTop = term.scrollHeight; }
  else term.innerHTML = `<div class="terminal-empty">输入 dsh 命令回车，输出将实时显示在这里。</div>`;
}
function syncConsoleButtons() {
  S.consoleRunning = !!(S.consoleRunning);
  document.querySelectorAll('[data-act="consoleRun"]').forEach((b) => { b.disabled = S.consoleRunning; });
  document.querySelectorAll('[data-act="consoleStop"]').forEach((b) => { b.disabled = !S.consoleRunning; });
  const st = $("#consoleState");
  if (st) { st.textContent = S.consoleRunning ? "运行中" : "空闲"; st.className = "pill " + (S.consoleRunning ? "warn" : "ok"); }
}
async function loadConsoleState() {
  try {
    const d = await api("/api/console");
    S.consoleRunning = d.console.running;
    S.consoleLines = (d.console.lines || []).map((l) => l.text);
    renderConsoleHistory(S.consoleLines);
  } catch (e) { /* ignore */ }
  syncConsoleButtons();
}
async function runConsole() {
  const input = $("#consoleCmd").value.trim();
  if (!input) return toast("请输入命令（以 dsh 开头）", "err");
  try { await api("/api/console/exec", { method: "POST", body: { input } }); }
  catch (e) { toast(e.message, "err"); }
}
async function stopConsole() {
  try { await api("/api/console/stop", { method: "POST" }); toast("已停止", "ok"); }
  catch (e) { toast(e.message, "err"); }
}

/* ---------------- 动作分发 ---------------- */
async function launchWeb(quiet) {
  setBusy(true, "正在启动 dsh web…");
  try { await api("/api/launch", { method: "POST" }); if (!quiet) toast("已启动 dsh web", "ok"); switchView("launch"); }
  catch (e) { toast(e.message, "err"); }
  finally { refresh(); }
}
async function stopWeb() {
  const st = S.status && S.status.web;
  if (!st || !st.running) return;
  const ok = await confirmBox({ title: "停止 dsh web", html: "确定停止正在运行的 dsh web 吗？", okLabel: "停止" });
  if (!ok) return;
  try { await api("/api/stop", { method: "POST" }); toast("已停止", "ok"); }
  catch (e) { toast(e.message, "err"); }
  refresh();
}

function bindActions() {
  document.body.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === "build") { setBusy(true, "构建中…"); try { await api("/api/build", { method: "POST" }); toast("构建完成", "ok"); } catch (err) { toast(err.message, "err"); } finally { refresh(); } }
    else if (act === "launch") launchWeb(false);
    else if (act === "stop") stopWeb();
    else if (act === "restart") { try { await api("/api/stop", { method: "POST" }); setTimeout(() => launchWeb(true), 600); } catch (e) { toast(e.message, "err"); } }
    else if (act === "backup") doBackup();
    else if (act === "backupRefresh") refresh();
    else if (act === "check") checkUpdate(false);
    else if (act === "upgrade") doUpgrade();
    else if (act === "addremote") addRemote();
    else if (act === "refreshVersions") { checkUpdate(false); }
    else if (act === "doctorRun") runDoctor(false);
    else if (act === "doctorFixSettings") doctorFixSettings();
    else if (act === "doctorFixKey") doctorFixKey();
    else if (act === "consoleRun") runConsole();
    else if (act === "consoleStop") stopConsole();
    else if (act === "saveConfig") saveConfig();
  });
}

async function doBackup() {
  const overwrite = $("#optOverwrite").checked;
  setBusy(true, "备份中…");
  try { await api("/api/backup", { method: "POST", body: { overwrite } }); toast("备份完成", "ok"); }
  catch (e) { toast(e.message, "err"); }
  finally { refresh(); }
}
async function addRemote() {
  const ok = await confirmBox({ title: "添加官方 remote", html: `将为仓库添加 <code>origin → ${esc(S.status ? S.status.mixed.officialRemote : "")}</code>，用于拉取版本与检测更新。`, okLabel: "添加" });
  if (!ok) return;
  setBusy(true, "配置 remote…");
  try { await api("/api/remote/add", { method: "POST" }); toast("已配置", "ok"); }
  catch (e) { toast(e.message, "err"); }
  finally { refresh(); }
}
async function saveConfig() {
  const body = {
    repoPath: $("#cfgRepoPath").value.trim(),
    dshHome: $("#cfgDshHome").value.trim(),
    port: parseInt($("#cfgPort").value, 10),
    webPort: parseInt($("#cfgWebPort").value, 10),
    launchMode: $("#cfgLaunchMode").value,
    launchProfile: $("#cfgLaunchProfile").value.trim(),
    officialRemote: $("#cfgRemote").value.trim(),
    autoBackupBeforeUpgrade: $("#cfgAutoBackup").checked,
    safetyBackupBeforeRestore: $("#cfgSafety").checked,
    maxBackups: parseInt($("#cfgMaxBackups").value, 10),
  };
  try { await api("/api/config", { method: "POST", body }); toast("设置已保存（部分项需重启 manager 生效）", "ok"); }
  catch (e) { toast(e.message, "err"); }
}

/* ---------------- 视图切换 ---------------- */
function switchView(name) {
  history.replaceState(null, "", "#" + name);
  renderView(name);
}
function isView(n) { return location.hash === "#" + n; }
function renderView(name) {
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  const titles = { dashboard: "状态总览", launch: "启动 web", update: "更新升级", versions: "版本 / 回滚", backups: "数据备份", env: "环境检查", doctor: "诊断 Doctor", console: "控制台 Console", settings: "设置" };
  $("#viewTitle").textContent = titles[name] || "";
  if (name === "env" && S.status) { renderEnv(); renderGitState(); }
  if (name === "settings") renderConfigForm();
  if (name === "backups" && S.status) renderBackups(S.status.backups);
  if (name === "doctor" && !S.doctorLoaded) runDoctor(true);
  if (name === "versions") loadVersions(false);
  if (name === "update" && S.updateInfo === null) checkUpdate(true);
  if (name === "console") loadConsoleState();
}
function renderUpgradeBtn() {
  const b = $("#btnUpgrade");
  if (b) b.disabled = !(S.updateInfo && S.updateInfo.hasUpdate) || S.busy;
}
function initNav() {
  const def = "dashboard";
  $$(".nav-item").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));
  window.addEventListener("hashchange", () => renderView(location.hash.replace("#", "") || def));
  renderView(location.hash.replace("#", "") || def);
}

/* ---------------- 周期刷新 ---------------- */
async function refresh() {
  try {
    const d = await api("/api/status");
    S.status = d;
    if (d.web.running && d.web.recentLog && d.web.recentLog.length) {
      // 已在运行则把日志灌入
      const term = $("#webLog");
      if (!term.querySelector(".terminal-empty")) {
        term.innerHTML = d.web.recentLog.map((l) => `<div>${esc(l)}</div>`).join("");
        term.scrollTop = term.scrollHeight;
      }
    }
    renderStatus();
    renderUpgradeBtn();
  } catch (e) { /* 服务可能重启 */ }
}

/* ---------------- 启动 ---------------- */
function init() {
  initNav();
  bindActions();
  connectSSE();
  refresh();
  setInterval(refresh, 5000);
  const ic = $("#consoleCmd");
  if (ic) ic.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); runConsole(); } });
  syncConsoleButtons();
}
init();