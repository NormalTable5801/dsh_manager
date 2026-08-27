"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const S = {
  status: null,
  versions: [],
  updateInfo: null,
  hasRemote: false,
  currentVersion: "",
  latestTag: null,
  taskLines: [],
  taskName: "",
  busy: false,
  consoleRunning: false,
  consoleLines: [],
  retry: null,
  retryProvider: null,
  plugins: null,
  profSel: "web",
  doctorLoaded: false,
  // 本会话内用户已手动关闭首次引导，避免后续轮询/SSE 再把它弹回来
  onboardDismissed: false,
  doctorRanAt: null,
};

const fmtBytes = (n) => {
  if (!isFinite(n)) return "-";
  const u = ["B","KB","MB","GB","TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${u[i]}`;
};
const fmtDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString("zh-CN", { hour12: false });
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function refreshIcons(root = document) {
  if (typeof lucide !== "undefined") {
    try { lucide.createIcons({ attrs: { "stroke-width": 1.5 }, root }); } catch { lucide.createIcons(); }
  }
}

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

/* ---------------- 提示 / 确认 / 模态框 ---------------- */
const toastIcons = {
  ok: "check-circle-2",
  err: "x-circle",
  info: "info",
  warn: "alert-triangle",
  "": "info",
};
function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = "toast " + (kind || "");
  const iconName = toastIcons[kind] || toastIcons[""];
  el.innerHTML = `<i data-lucide="${esc(iconName)}" class="toast-icon ${kind ? "" : "toast-icon-info"}"></i><span class="toast-msg">${esc(msg)}</span>`;
  $("#toasts").appendChild(el);
  refreshIcons(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transform = "translateX(20px)"; setTimeout(() => el.remove(), 200); }, 4200);
}

let modalResolve = null;
let modalCleanup = null;
let modalCancelFn = null;

function bindModalClose() {
  const modal = $("#modal");
  const closeBtn = $("#modalClose");
  const onBackdrop = (e) => { if (e.target === modal) closeModal(true); };
  const onEsc = (e) => { if (e.key === "Escape") closeModal(true); };
  const onCloseBtn = () => closeModal(true);
  modal.addEventListener("click", onBackdrop);
  closeBtn.addEventListener("click", onCloseBtn);
  document.addEventListener("keydown", onEsc);
  return () => {
    modal.removeEventListener("click", onBackdrop);
    closeBtn.removeEventListener("click", onCloseBtn);
    document.removeEventListener("keydown", onEsc);
  };
}

function openModal() {
  $("#modal").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  if (!modalCleanup) modalCleanup = bindModalClose();
}

function closeModal(cancel = false) {
  if (cancel && modalCancelFn) { modalCancelFn(); }
  $("#modal").classList.add("hidden");
  document.body.style.overflow = "";
  if (modalCleanup) { modalCleanup(); modalCleanup = null; }
  modalCancelFn = null;
}

function confirmBox({ title = "确认", html, okLabel = "确认", cancelLabel = "取消" }) {
  return new Promise((resolve) => {
    modalResolve = resolve;
    const ok = $("#modalOk"), cancel = $("#modalCancel");
    $("#modalTitle").textContent = title;
    $("#modalBody").innerHTML = html;
    ok.textContent = okLabel;
    cancel.textContent = cancelLabel;
    ok.className = "action-btn primary";
    cancel.classList.remove("hidden");
    openModal();
    refreshIcons($("#modal"));

    const done = (v) => {
      closeModal();
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      modalResolve = null;
      modalCancelFn = null;
      resolve(v);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    modalCancelFn = onCancel;
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
  });
}

function formModal({ title, fields, okLabel = "确定", cancelLabel = "取消" }) {
  return new Promise((resolve) => {
    modalResolve = resolve;
    const ok = $("#modalOk"), cancel = $("#modalCancel");
    $("#modalTitle").textContent = title;
    const rows = fields.map((f) => {
      const v = esc(f.value ?? "");
      let input;
      if (f.type === "select") {
        input = `<select name="${esc(f.name)}">` + (f.options || []).map((o) => `<option value="${esc(o)}" ${String(o) === String(f.value) ? "selected" : ""}>${esc(o)}</option>`).join("") + "</select>";
      } else if (f.type === "checkbox") {
        input = `<input type="checkbox" name="${esc(f.name)}" ${f.value ? "checked" : ""}>`;
      } else if (f.type === "password") {
        input = `<input name="${esc(f.name)}" type="password" value="${v}" placeholder="${esc(f.placeholder || "")}" class="key-input" autocomplete="off">`;
      } else {
        input = `<input name="${esc(f.name)}" type="text" value="${v}" placeholder="${esc(f.placeholder || "")}">`;
      }
      return `<label><span class="label-text">${esc(f.label || f.name)}</span>${input}</label>`;
    }).join("");
    $("#modalBody").innerHTML = `<div class="form-inline">${rows}</div>`;
    ok.textContent = okLabel;
    cancel.textContent = cancelLabel;
    ok.className = "action-btn primary";
    cancel.classList.remove("hidden");
    openModal();
    refreshIcons($("#modal"));
    const firstInput = $("#modalBody input, #modalBody select");
    if (firstInput) firstInput.focus();

    const done = (o) => {
      closeModal();
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      modalResolve = null;
      modalCancelFn = null;
      resolve(o);
    };
    const onOk = () => {
      const out = {};
      $("#modalBody").querySelectorAll("[name]").forEach((el) => { out[el.name] = el.type === "checkbox" ? el.checked : el.value.trim(); });
      done(out);
    };
    const onCancel = () => done(null);
    modalCancelFn = onCancel;
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
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
    if (m.type === "task:start") { S.taskLines = []; S.taskName = m.task ? m.task.name : ""; setBusy(true, S.taskName + "…"); renderTaskLogs(); renderStatus(); if (isPluginTask(S.taskName)) initPluginLog(); }
    else if (m.type === "task:line") { S.taskLines.push(m.line.text); renderTaskLogs(); appendPluginLine(m.line.text); }
    else if (m.type === "task:end") { setBusy(false); refresh(); renderUpgradeBtn(); }
    else if (m.type === "web:change") { renderWeb(); }
    else if (m.type === "web:line") { appendWebLog(m.line); }
    else if (m.type === "console:start") { S.consoleRunning = true; S.consoleLines = []; const t = $("#consoleOut"); if (t) { t.innerHTML = ""; } appendConsoleLine("$ " + (m.cmd || ""), "input"); syncConsoleButtons(); }
    else if (m.type === "console:line") { S.consoleRunning = true; appendConsoleLine(m.line.text); }
    else if (m.type === "console:end") { S.consoleRunning = false; appendConsoleLine("[进程结束，退出码 " + m.code + "]", "muted"); syncConsoleButtons(); }
  };
  es.onerror = () => {
    const dot = $("#connDot");
    dot.innerHTML = '<span class="conn-dot"></span>已断开，重连中…';
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
  renderEnvActions(st);
  const ob = $("#onboard");
  if (ob) ob.classList.toggle("hidden", !!st.onboarded || S.onboardDismissed);
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

function envChip(name, val, good, tool, help) {
  const hasHelp = !!(help && help.cmd);
  return `<span class="chip ${good ? "good" : val ? "bad" : "warn"}"><b>${name}</b> ${esc(val || "未检测到")}` +
    (hasHelp ? `<span class="chip-acts"><button class="link-btn" data-act="envCopy" data-tool="${tool}" title="复制安装命令"><i data-lucide="copy"></i></button>` +
      `<a class="link-btn" href="${esc(help.url)}" target="_blank" rel="noopener" title="官方下载页"><i data-lucide="external-link"></i></a></span>` : "") +
    `</span>`;
}
function renderEnvStrip(env) {
  $("#envStrip").innerHTML =
    envChip("node", env.node, !!env.nodeOk, "node", env.nodeHelp) +
    envChip("pnpm", env.pnpm, !!env.pnpm, "pnpm", env.pnpmHelp) +
    envChip("git", String(env.git || "").replace(/^git version\s+/i, ""), !!env.git, "git", env.gitHelp);
  refreshIcons($("#envStrip"));
}
function renderEnvActions(st) {
  const missing = st.envMissing || [];
  const acts = [];
  if (missing.length) {
    acts.push(`<button class="action-btn small success" data-act="depsAuto" title="用 winget / corepack 自动安装缺失依赖（可能需要管理员权限）">自动安装缺失依赖</button>`);
    acts.push(`<button class="action-btn small" data-act="depsCopyMissing" title="复制全部缺失依赖的安装命令">复制缺失安装命令</button>`);
    acts.push(`<button class="action-btn small" data-act="depsOpen" data-tool="${missing[0]}" title="打开官方下载页（引导式）">打开官方下载页</button>`);
  } else {
    acts.push(`<span class="env-ok">依赖齐全</span>`);
  }
  if (!st.repoExists) {
    acts.push(`<button class="action-btn small primary" data-act="depsClone" title="git clone 官方 Harness 仓库，并设为当前仓库路径">获取 Harness 源码（clone）</button>`);
  }
  $("#envActions").innerHTML = acts.join(" ");
  refreshIcons($("#envActions"));
}
function depHelp(tool) {
  return S.status && S.status.env && S.status.env[tool + "Help"];
}
function copyText(text) {
  return navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error("当前环境不支持自动复制"));
}

function renderWeb() {
  const st = S.status;
  if (!st) return;
  const web = st.web;
  const box = $("#launchStatus");
  const lines = [];
  if (web.running) {
    lines.push(`<div class="l"><span class="ok">●</span> 运行中    PID: ${web.pid}</div>`);
    lines.push(`<div class="l">启动时间: ${fmtDate(new Date(web.startedAt).toISOString())}</div>`);
    lines.push(`<div class="l">profile: ${esc(web.profile)}  模式: ${esc(web.mode)}  端口: ${web.configuredPort || "自动"}</div>`);
    lines.push(web.url ? `<div class="l ok">访问地址: <a style="color:var(--primary)" target="_blank" href="${web.url}">${web.url}</a></div>` : `<div class="l muted">尚未捕获到访问地址…</div>`);
  } else {
    lines.push(`<div class="l">● 已停止</div>`);
    if (web.externalOccupied) lines.push(`<div class="l warn">端口 ${web.configuredPort} 被其他进程占用，请检查</div>`);
  }
  box.innerHTML = lines.join("") || "—";
  $("#btnRestart").disabled = !web.running;
  syncWebButtons();
}

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
    if (fetchFirst) await api("/api/versions");
    const d = await api("/api/versions");
    renderVersions(d);
    if (S.status) { S.hasRemote = S.status.remoteConfigured; }
  } catch (e) { toast(e.message, "err"); }
}
function renderVersions(d) {
  S.versions = d.versions || [];
  const list = $("#versionList");
  if (!S.versions.length) { list.innerHTML = `<div class="muted" style="padding:14px">暂无版本标签。点击“拉取版本列表”从官方仓库抓取。</div>`; return; }
  const cur = d.current;
  const latest = S.versions[0];
  list.innerHTML = S.versions.map((v) => {
    const isCur = v.v === cur || v.tag === cur;
    const isLatest = latest && v.tag === latest.tag;
    return `<div class="vrow ${isCur ? "cur" : ""}">
      <div class="vtag">${esc(v.tag)}</div>
      <div class="vmeta">${isCur ? '<span class="badge cur-badge">当前版本</span>' : ""} ${isLatest && !isCur ? '<span class="badge latest-badge">最新</span>' : ""}</div>
      <div>
        ${isCur ? "" : `<button class="tag-btn" data-rollback="${esc(v.tag)}">回滚到此版</button>`}
        <span class="muted" style="font-size:11px">当前版 ${esc(cur)}</span>
      </div>
    </div>`;
  }).join("") || `<div class="muted" style="padding:14px">无版本</div>`;
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
    if (!silent) toast(d.hasUpdate ? "发现新版本，可升级" : "已是最新", d.hasUpdate ? "info" : "ok");
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
    await api("/api/upgrade", { method: "POST", body: { autoBackup: true, target: S.updateInfo.latest } });
    toast("升级完成", "ok");
  } catch (e) { toast(e.message, "err"); } finally { refresh(); }
}

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
    <td style="font-family:var(--font-mono)">${esc(b.id)}</td>
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

/* ---------------- 重试策略 Retry Policy ---------------- */
async function loadRetry() {
  try {
    const d = await api("/api/retry");
    S.retry = d;
    renderRetry();
  } catch (e) { toast(e.message, "err"); }
}
function renderRetry() {
  const d = S.retry;
  const sel = $("#rpProvider");
  if (!d || !sel) return;
  const provs = d.providers || [];
  if (!provs.length) {
    sel.innerHTML = `<option value="">（settings.yaml 中未找到 provider）</option>`;
    clearRetryForm();
    $("#rpStatus").textContent = "未找到可配置的 provider";
    $("#rpStatus").className = "pill err";
    return;
  }
  const current = S.retryProvider && provs.find((p) => p.topKey === S.retryProvider.topKey && p.providerId === S.retryProvider.providerId);
  const curIdx = current ? provs.indexOf(current) : 0;
  const cur = provs[curIdx];
  sel.innerHTML = provs.map((p, i) =>
    `<option value="${i}" ${i === curIdx ? "selected" : ""}>${esc(p.providerId)}${p.kind === "pi-ai" ? " · " + esc(p.topKey) : ""}${p.retryPolicy ? " · 已配置" : ""}</option>`
  ).join("");
  S.retryProvider = { topKey: cur.topKey, providerId: cur.providerId };
  fillRetryForm(cur.retryPolicy);
}
function clearRetryForm() {
  $("#rpMode").value = "normal";
  $("#rpInitial").value = "";
  $("#rpMax").value = "";
  $("#rpJitter").value = "";
  $("#rpMaxRetries").value = "";
  $("#rpCodes").value = "";
  $("#rpStatus").textContent = "—";
  $("#rpStatus").className = "pill";
  syncRetryNormalFields();
}
function fillRetryForm(pol) {
  if (!pol) {
    clearRetryForm();
    $("#rpStatus").textContent = "未配置（保存后写入 settings.yaml）";
    $("#rpStatus").className = "pill warn";
    return;
  }
  $("#rpMode").value = pol.mode === "always" ? "always" : "normal";
  $("#rpInitial").value = pol.backoff && pol.backoff.initialDelayMs != null ? pol.backoff.initialDelayMs : "";
  $("#rpMax").value = pol.backoff && pol.backoff.maxDelayMs != null ? pol.backoff.maxDelayMs : "";
  $("#rpJitter").value = pol.backoff && pol.backoff.jitterRatio != null ? pol.backoff.jitterRatio : "";
  $("#rpMaxRetries").value = pol.maxRetries != null ? pol.maxRetries : "";
  $("#rpCodes").value = (pol.retryableCodes || []).join(", ");
  $("#rpStatus").textContent = "已配置：" + esc(pol.mode);
  $("#rpStatus").className = "pill ok";
  syncRetryNormalFields();
}
function syncRetryNormalFields() {
  const normal = $("#rpMode").value === "normal";
  $("#rpMaxRetries").disabled = !normal;
  $("#rpCodes").disabled = !normal;
}
function onRetryProviderChange() {
  const provs = (S.retry && S.retry.providers) || [];
  const p = provs[Number($("#rpProvider").value)];
  if (!p) return;
  S.retryProvider = { topKey: p.topKey, providerId: p.providerId };
  fillRetryForm(p.retryPolicy);
}
async function saveRetry() {
  if (!S.retryProvider) return toast("请先选择提供方", "err");
  const mode = $("#rpMode").value;
  const num = (id) => { const v = $("#" + id).value; return v === "" || v == null ? undefined : Number(v); };
  const _init = num("rpInitial"), _max = num("rpMax");
  if (_init != null && _max != null && _init > _max) return toast("初始间隔 initialDelayMs 不能大于最大间隔 maxDelayMs（否则 harness 会判定模型不可用）", "err");
  const body = {
    topKey: S.retryProvider.topKey,
    providerId: S.retryProvider.providerId,
    retryPolicy: {
      mode,
      backoff: {
        initialDelayMs: num("rpInitial"),
        maxDelayMs: num("rpMax"),
        jitterRatio: num("rpJitter"),
      },
      ...(mode === "normal"
        ? {
            maxRetries: num("rpMaxRetries"),
            retryableCodes: $("#rpCodes").value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean),
          }
        : {}),
    },
  };
  try {
    await api("/api/retry", { method: "POST", body });
    toast("重试策略已保存（重启 dsh web 后生效）", "ok");
    loadRetry();
  } catch (e) { toast(e.message, "err"); }
}

/* ---------------- 诊断 Doctor ---------------- */
const doctorIcons = {
  ok: "check-circle-2",
  warn: "alert-triangle",
  err: "x-circle",
};
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
  $("#doctorSummary").innerHTML = `<i data-lucide="check-circle-2" style="width:12px;height:12px"></i> ${sum.ok} · <i data-lucide="alert-triangle" style="width:12px;height:12px"></i> ${sum.warn} · <i data-lucide="x-circle" style="width:12px;height:12px"></i> ${sum.error}`;
  $("#doctorSummary").className = "pill " + (sum.error ? "err" : sum.warn ? "warn" : "ok");
  const box = $("#doctorResult");
  box.innerHTML = (d.findings || []).map((f) => {
    const icon = doctorIcons[f.severity] || "info";
    return `<div class="drow ${f.severity}">
      <div class="dline"><i data-lucide="${icon}" class="dmark"></i><b>${esc(f.title)}</b> <span class="did">[${esc(f.checkId)}]</span><span class="dlev">${esc(f.level)}</span>${f.message ? ` — ${esc(f.message)}` : ""}</div>
      ${f.remediation ? `<div class="drem"><i data-lucide="wrench" style="width:12px;height:12px"></i> ${esc(f.remediation)}</div>` : ""}
      ${f.detail ? `<div class="ddetail">${esc(f.detail)}</div>` : ""}
    </div>`;
  }).join("") || '<div class="muted">无检查结果。</div>';
  if (S.doctorRanAt) box.insertAdjacentHTML("beforeend", `<div class="muted" style="margin-top:8px">上次运行：${fmtDate(new Date(S.doctorRanAt).toISOString())}</div>`);
  refreshIcons(box);
}
async function doctorFixSettings() {
  const ok = await confirmBox({ title: "修复 settings.yaml", html: "为空/损坏的 settings.yaml<b>先备份为 .doctor-bak</b> 再写入最小合法配置（非空则不动）。", okLabel: "修复" });
  if (!ok) return;
  try {
    const r = await api("/api/doctor/fix", { method: "POST", body: { target: "settings" } });
    toast((r.fix.applied ? "已修复：\u200b" : "跳过：") + r.fix.message, r.fix.applied ? "ok" : "info");
  } catch (e) { toast(e.message, "err"); }
  runDoctor(true);
}
async function doctorFixKey() {
  const out = await formModal({
    title: "补写 DEEPSEEK_API_KEY",
    fields: [
      { name: "key", label: "DEEPSEEK_API_KEY", type: "password", placeholder: "sk-..." }
    ],
    okLabel: "写入",
  });
  if (!out || !out.key) return;
  try {
    const r = await api("/api/doctor/fix", { method: "POST", body: { target: "credentials", value: out.key } });
    toast((r.fix.applied ? "已写入：\u200b" : "跳过：") + r.fix.message, r.fix.applied ? "ok" : "info");
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

/* ---------------- 插件 Plugins ---------------- */
async function loadPlugins() {
  try {
    const d = await api("/api/plugins");
    S.plugins = d;
    renderProfiles();
  } catch (e) { toast(e.message, "err"); }
}
function renderProfiles() {
  const d = S.plugins; if (!d) return;
  const profiles = d.profiles || [];
  if (!profiles.length) {
    $("#profSel").innerHTML = `<option value="">（无可用 profile）</option>`;
    $("#profRows").innerHTML = `<tr><td colspan="4" class="muted">未在 $DSH_HOME/profiles 下发现任何已初始化的 profile。</td></tr>`;
    $("#profPath").textContent = "";
    return;
  }
  if (!profiles.some((p) => p.name === S.profSel)) S.profSel = profiles[0].name;
  $("#profSel").innerHTML = profiles.map((p) => `<option value="${esc(p.name)}" ${p.name === S.profSel ? "selected" : ""}>${esc(p.name)}${p.template ? " · " + esc(p.template) : ""}</option>`).join("");
  const cur = profiles.find((p) => p.name === S.profSel);
  $("#profPath").textContent = cur ? cur.dir : "";
  const mode = cur ? cur.plugins : [];
  $("#profRows").innerHTML = mode.map((p) => `
    <tr>
      <td class="mono">${esc(p.pkg)} ${p.spec !== p.pkg ? '<span class="muted" style="font-size:12px">(' + esc(p.spec) + ")</span>" : ""}</td>
      <td>${p.kind === "link" ? '<span class="pill warn">桥接 workspace</span>' : '<span class="pill ok">官方包</span>'}</td>
      <td><button class="action-btn small ${p.enabled ? "success" : ""}" data-act="profToggle" data-profile="${esc(cur.name)}" data-pkg="${esc(p.pkg)}" data-enable="${p.enabled ? "false" : "true"}">${p.enabled ? "关闭" : "启用"}</button></td>
      <td><button class="action-btn small danger" data-act="profRemove" data-profile="${esc(cur.name)}" data-pkg="${esc(p.pkg)}">卸载</button></td>
    </tr>`).join("") || `<tr><td colspan="4" class="muted">该 profile 暂无 dependency 插件。</td></tr>`;
  refreshIcons($("#profRows").closest("table"));
}
async function profAdd() {
  if (!S.plugins || !(S.plugins.profiles || []).length) return toast("无可用 profile，无法添加", "err");
  const out = await new Promise((resolve) => {
    modalResolve = resolve;
    const ok = $("#modalOk"), cancel = $("#modalCancel");
    $("#modalTitle").textContent = `添加 Profile 插件（profile: ${S.profSel}）`;
    $("#modalBody").innerHTML = `
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <button class="action-btn small primary" type="button" id="modeSearch">搜索安装</button>
        <button class="action-btn small" type="button" id="modeManual">手输 spec</button>
      </div>
      <div id="psPane"></div>`;
    ok.textContent = "关闭"; cancel.textContent = "取消";
    ok.className = "action-btn";
    cancel.classList.remove("hidden");
    openModal();
    refreshIcons($("#modal"));

    const done = (o) => {
      closeModal();
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      modalResolve = null;
      modalCancelFn = null;
      resolve(o);
    };
    const onOk = () => done(null);
    const onCancel = () => done(null);
    modalCancelFn = onCancel;
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);

    function showSearch() {
      $("#modeSearch").classList.add("primary"); $("#modeManual").classList.remove("primary");
      $("#psPane").innerHTML = `
        <div class="form-inline">
          <label><span class="label-text">关键词</span><input id="psQ" type="text" placeholder="包名 / owner·repo / 关键词" style="width:100%"></label>
          <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
            <label class="checkbox"><input type="checkbox" id="psSrcNpm" checked> npm</label>
            <label class="checkbox"><input type="checkbox" id="psSrcGh" checked> GitHub</label>
            <button class="action-btn primary" id="psGo">开始搜索</button>
          </div>
        </div>
        <div id="psResults" style="margin-top:12px"></div>
        <div id="psInstallWrap" style="display:none;margin-top:10px"><button class="action-btn success" id="psInstall">安装所选</button> <span class="muted" style="font-size:12px">可多选；git 源可能触发白名单提示</span></div>`;
      refreshIcons($("#psPane"));
      const doSearch = async () => {
        const q = $("#psQ").value.trim(); if (!q) return toast("请输入关键词", "err");
        const srcs = []; if ($("#psSrcNpm").checked) srcs.push("npm"); if ($("#psSrcGh").checked) srcs.push("github");
        if (!srcs.length) return toast("请至少勾选一个来源", "err");
        const res = $("#psResults"); res.innerHTML = `<div class="muted">正在搜索 ${srcs.join(" + ")} …</div>`;
        try { const data = await api("/api/plugins/search?q=" + encodeURIComponent(q) + "&sources=" + encodeURIComponent(srcs.join(","))); renderSearchCards(data.cards || []); }
        catch (e) { res.innerHTML = `<div class="muted">${esc(e.message)}</div>`; }
      };
      $("#psGo").addEventListener("click", doSearch);
      const q = $("#psQ"); q.focus();
      q.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doSearch(); } });
      if (!window._psResultBound) { $("#psResults").addEventListener("change", (e) => { if (e.target.matches("input[data-source]")) psSyncInstall(); }); window._psResultBound = true; }
      $("#psInstall").addEventListener("click", psInstallSel);
    }
    function showManual() {
      $("#modeManual").classList.add("primary"); $("#modeSearch").classList.remove("primary");
      $("#psPane").innerHTML = `
        <div class="form-inline">
          <label><span class="label-text">npm 依赖规格</span><input id="psSpec" type="text" placeholder="例如 @scope/pkg@^1.2.0" style="width:100%"></label>
          <label class="checkbox"><input type="checkbox" id="psBundle" checked> 同时加入 bundle 层（启用）</label>
        </div>
        <div style="margin-top:10px"><button class="action-btn success" id="psManualInstall">安装</button></div>`;
      refreshIcons($("#psPane"));
      $("#psManualInstall").addEventListener("click", async () => {
        const spec = $("#psSpec").value.trim(); if (!spec) return toast("请输入 spec", "err");
        initPluginLog(); setBusy(true, "安装插件…");
        try { await api("/api/plugins/profile/add", { method: "POST", body: { profile: S.profSel, packageSpec: spec, bundle: !!$("#psBundle").checked } }); toast("已安装（重启 dsh web 后生效）", "ok"); }
        catch (e) { toast(e.message, "err"); } finally { setBusy(false); loadPlugins(); }
      });
    }
    $("#modeSearch").addEventListener("click", showSearch);
    $("#modeManual").addEventListener("click", showManual);
    showSearch();
  });
}
async function renderSearchCards(list) {
  const res = $("#psResults"); if (!res) return;
  const cards = list.filter((c) => !c.error);
  const errs = list.filter((c) => c.error);
  res.innerHTML =
    (cards.length ? cards.map((c) => `
      <label class="ps-card ${c.source === "npm" ? "npm" : "github"}">
        <input type="checkbox" name="pscard" data-source="${c.source}" data-spec="${esc(c.spec)}">
        <span class="pc-main">
          <span class="pc-name">${esc(c.label)} <span class="src-badge ${c.source}">${c.source}</span> ${c.pnpmGate ? '<span class="pill warn">需 pnpm 白名单</span>' : ""}</span>
          <span class="pc-extra">${esc(c.extra)}</span>
          <span class="pc-desc">${esc(c.description || "（无描述）")}</span>
          ${c.pnpmGate && c.pnpmGateText ? `<span class="pc-warn"><i data-lucide="alert-triangle" style="width:12px;height:12px"></i> ${esc(c.pnpmGateText)}</span>` : ""}
        </span>
      </label>`).join("") : `<div class="muted">该来源未搜到结果。</div>`) +
    (errs.length ? `<div class="muted" style="margin-top:8px">部分来源搜索失败：${errs.map((x) => `${x.source}: ${esc(x.error)}`).join("；")}</div>` : "");
  refreshIcons(res);
  psSyncInstall();
}
function psSyncInstall() {
  const wrap = $("#psInstallWrap"); if (!wrap) return;
  const n = $$("#psResults input[data-source]:checked").length;
  wrap.style.display = n ? "block" : "none";
  $("#psInstall").textContent = `安装所选（${n}）`;
}
async function psInstallSel() {
  const sel = $$("#psResults input[data-source]:checked");
  if (!sel.length) return;
  initPluginLog();
  setBusy(true, "安装所选插件…");
  let done = 0, fail = 0;
  try {
    for (const ch of sel) {
      try { await api("/api/plugins/profile/add", { method: "POST", body: { profile: S.profSel, packageSpec: ch.dataset.spec, bundle: true } }); done++; }
      catch (e) { fail++; toast(e.message, "err"); }
    }
    toast(`安装完成：成功 ${done}，失败 ${fail}（重启 dsh web 后生效）`, fail ? "err" : "ok");
  } finally { setBusy(false); loadPlugins(); }
}
async function profToggle(btn) {
  initPluginLog();
  const enable = btn.dataset.enable === "true";
  try { await api("/api/plugins/profile/toggle", { method: "POST", body: { profile: btn.dataset.profile, pkg: btn.dataset.pkg, enabled: enable } }); }
  catch (e) { toast(e.message, "err"); }
  loadPlugins();
}
async function profRemove(btn) {
  initPluginLog();
  const ok = await confirmBox({ title: "卸载 Profile 插件", html: `确定从 profile <code>${esc(btn.dataset.profile)}</code> 卸载 <code>${esc(btn.dataset.pkg)}</code> 吗？`, okLabel: "卸载" });
  if (!ok) return;
  try { await api("/api/plugins/profile/remove", { method: "POST", body: { profile: btn.dataset.profile, pkg: btn.dataset.pkg } }); toast("已卸载", "ok"); }
  catch (e) { toast(e.message, "err"); }
  loadPlugins();
}
function initPluginLog() {
  const log = $("#pluginLog");
  if (log) log.innerHTML = `<div class="terminal-empty">任务已开始，输出将实时显示…</div>`;
}
function isPluginTask(name) { return typeof name === "string" && /profile 插件/.test(name); }
function appendPluginLine(text) {
  if (text == null) return;
  const log = $("#pluginLog");
  if (!log || !isPluginTask(S.taskName)) return;
  const empty = log.querySelector(".terminal-empty");
  if (empty) empty.remove();
  const div = document.createElement("div");
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  if (log.childElementCount > 500) log.removeChild(log.firstElementChild);
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

async function copyMissingCmds() {
  const missing = (S.status && S.status.envMissing) || [];
  const cmds = [];
  for (const t of missing) { const h = depHelp(t); if (h && h.cmd) cmds.push(h.cmd.trim()); }
  if (!cmds.length) { toast("没有需要处理的缺失依赖", "info"); return; }
  try { await copyText(cmds.join("\n")); toast("已复制缺失依赖的安装命令", "ok"); }
  catch { toast("复制失败，请在开发模式手动复制", "err"); }
}
async function autoInstall() {
  const missing = (S.status && S.status.envMissing) || [];
  const ok = await confirmBox({ title: "自动安装缺失依赖", html: `将通过 winget / corepack 自动安装：<b>${esc(missing.join("、") || "—")}</b>。<br/><span class="warn-title">会改动你的系统环境</span>，node / git 走 winget 可能需要管理员权限。是否继续？`, okLabel: "自动安装" });
  if (!ok) return;
  setBusy(true, "自动安装依赖中…");
  try { const d = await api("/api/deps/install", { method: "POST", body: { tools: missing } }); toast((d.installed && d.installed.length ? `已触发安装：${d.installed.join("、")}` : "依赖已就绪"), "ok"); }
  catch (e) { toast(e.message, "err"); }
  finally { setBusy(false); setTimeout(() => refresh(), 2500); }
}
async function cloneHarness() {
  const ok = await confirmBox({ title: "获取 Harness 源码", html: `将执行 <code>git clone ${esc(S.status ? S.status.mixed.officialRemote : "…")}</code> 到 dsh_manager 的同级目录，并联接为仓库路径（<b>不会自动构建</b>，构建请点顶部按钮）。`, okLabel: "开始 clone" });
  if (!ok) return;
  setBusy(true, "拉取源码中…");
  try { const d = await api("/api/deps/clone", { method: "POST" }); toast(d.already ? "已存在 Harness 仓库" : "源码已获取，请到顶部点「构建 Harness」", "ok"); }
  catch (e) { toast(e.message, "err"); }
  finally { setBusy(false); refresh(); }
}
async function dismissOnboard() {
  // 本地优先：立即关闭，本会话内后续轮询/SSE 不再弹回
  S.onboardDismissed = true;
  if (S.status) S.status.onboarded = true;
  const ob = $("#onboard"); if (ob) ob.classList.add("hidden");
  try { await api("/api/onboard/ack", { method: "POST" }); } catch { /* 服务端持久化失败也不影响本会话 */ }
  toast("已了解，需要时可清空 config.json 重新显示引导", "info");
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
    else if (act === "retrySave") saveRetry();
    else if (act === "retryRefresh") { S.retry = null; loadRetry(); }
    else if (act === "pluginsRefresh") loadPlugins();
    else if (act === "profAdd") profAdd();
    else if (act === "profToggle") profToggle(btn);
    else if (act === "profRemove") profRemove(btn);
    else if (act === "envCopy") { const h = depHelp(btn.dataset.tool); if (!h) return; copyText(h.cmd).then(() => toast(`已复制 ${btn.dataset.tool} 安装命令`, "ok")).catch(() => toast("复制失败，请在开发模式手动复制", "err")); }
    else if (act === "depsOpen") { const h = depHelp(btn.dataset.tool); if (h && h.url) window.open(h.url, "_blank"); }
    else if (act === "depsCopyMissing") copyMissingCmds();
    else if (act === "depsAuto") autoInstall();
    else if (act === "depsClone") cloneHarness();
    else if (act === "onboardDismiss") dismissOnboard();
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

/* ---------------- 视图切换 / 移动端导航 ---------------- */
function toggleMenu(open) {
  const sidebar = $("#sidebar");
  const backdrop = $("#backdrop");
  const toggle = $("#menuToggle");
  const isOpen = sidebar.classList.contains("open");
  const next = open == null ? !isOpen : open;
  sidebar.classList.toggle("open", next);
  backdrop.classList.toggle("show", next);
  toggle.setAttribute("aria-expanded", String(next));
  toggle.querySelector(".icon-menu").classList.toggle("hidden", next);
  toggle.querySelector(".icon-close").classList.toggle("hidden", !next);
}
function initMobileMenu() {
  const toggle = $("#menuToggle");
  const backdrop = $("#backdrop");
  if (!toggle) return;
  toggle.addEventListener("click", () => toggleMenu());
  backdrop.addEventListener("click", () => toggleMenu(false));
  $$(".nav-item").forEach((b) => b.addEventListener("click", () => toggleMenu(false)));
}

function switchView(name) {
  history.replaceState(null, "", "#" + name);
  renderView(name);
}
function isView(n) { return location.hash === "#" + n; }
function renderView(name) {
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  const titles = { dashboard: "状态总览", launch: "启动 web", update: "更新升级", versions: "版本 / 回滚", backups: "数据备份", env: "环境检查", doctor: "诊断 Doctor", console: "控制台 Console", plugins: "插件 Plugins", settings: "设置" };
  $("#viewTitle").textContent = titles[name] || "";
  if (name === "env" && S.status) { renderEnv(); renderGitState(); }
  if (name === "settings") { renderConfigForm(); if (!S.retry) loadRetry(); }
  if (name === "backups" && S.status) renderBackups(S.status.backups);
  if (name === "doctor" && !S.doctorLoaded) runDoctor(true);
  if (name === "versions") loadVersions(false);
  if (name === "update" && S.updateInfo === null) checkUpdate(true);
  if (name === "console") loadConsoleState();
  if (name === "plugins") loadPlugins();
  refreshIcons();
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
  initMobileMenu();
  bindActions();
  connectSSE();
  refresh();
  setInterval(refresh, 5000);
  const ic = $("#consoleCmd");
  if (ic) ic.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); runConsole(); } });
  const rp = $("#rpProvider");
  if (rp) rp.addEventListener("change", onRetryProviderChange);
  const rpMode = $("#rpMode");
  if (rpMode) rpMode.addEventListener("change", syncRetryNormalFields);
  const profSel = $("#profSel");
  if (profSel) profSel.addEventListener("change", (e) => { S.profSel = e.target.value; renderProfiles(); });
  syncConsoleButtons();
  refreshIcons();
}
init();
