"use strict";
/*
 * dsh_manager · LLM 重试策略（retryPolicy）读写模块
 *
 * 直接对 $DSH_HOME/settings.yaml 做行级编辑（零第三方依赖），只更新/插入
 * 对应 provider 的 retryPolicy 段，不触碰文件其它内容；写入前先备份为
 * settings.yaml.retry-bak。
 *
 * 字段规范参考 harness packages/llm/llm/src/retry-policy.ts（RetryPolicySchema）：
 *   - mode: 'normal' | 'always'
 *   - backoff: { initialDelayMs(默认500), maxDelayMs(默认10000), jitterRatio(默认0.1) }
 *   - normal 模式额外: maxRetries(默认5), retryableCodes(默认
 *     [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT])
 *
 * 兼容两种 settings.yaml 结构：
 *   - pi-ai：  llm-pi-ai.providers.<id>.retryPolicy
 *   - direct： 顶层插件段自身即 provider（如 llm-deepseek 的 retryPolicy）
 */

const fs = require("fs");
const path = require("path");

const MODES = ["normal", "always"];
const DEFAULT_RETRYABLE = ["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"];
// Node setTimeout 上限，harness 的 MAX_TIMER_DELAY_MS 同值
const MAX_DELAY_MS = 2147483647;

/* ---------------- YAML 行级解析 ---------------- */

/** 解析一行 YAML 为结构化对象（保留 raw）。 */
function parseLine(raw) {
  const indent = (raw.match(/^\s*/) || [""])[0].length;
  const content = raw.trim();
  const out = { raw, indent, content, key: null, value: null, isListItem: false, listKey: null, listValue: null, empty: !content || content.startsWith("#") };
  if (out.empty) return out;
  if (content.startsWith("- ")) {
    out.isListItem = true;
    const rest = content.slice(2);
    const m = rest.match(/^([^:\s][^:]*?):\s*(.*)$/);
    if (m) { out.listKey = m[1].trim(); out.listValue = m[2].trim(); }
    else out.listValue = rest.trim();
    return out;
  }
  const m = content.match(/^([^:\s][^:]*?):\s*(.*)$/);
  if (m) { out.key = m[1].trim(); out.value = m[2].trim(); }
  return out;
}

/** 块结束索引（不含）：自 start 下一行起，遇缩进 <= 本行缩进的非空行即止。 */
function blockEnd(lines, start) {
  const base = lines[start].indent;
  for (let i = start + 1; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln.empty && ln.indent <= base) return i;
  }
  return lines.length;
}

function scalarNum(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

/** 解析 [start, end) 块内（provider 块）的 retryPolicy，无则返回 null。 */
function parseRetryPolicy(lines, start, end) {
  const base = lines[start].indent;
  let rp = -1;
  for (let i = start + 1; i < end; i++) {
    if (!lines[i].empty && lines[i].indent === base + 2 && lines[i].key === "retryPolicy") { rp = i; break; }
  }
  if (rp < 0) return null;
  const rpEnd = blockEnd(lines, rp);
  const rpIndent = lines[rp].indent;
  const pol = { mode: null, backoff: { initialDelayMs: null, maxDelayMs: null, jitterRatio: null }, maxRetries: null, retryableCodes: null };
  for (let i = rp + 1; i < rpEnd; i++) {
    const ln = lines[i];
    if (ln.empty || ln.isListItem) continue;
    if (ln.indent !== rpIndent + 2) continue;
    if (ln.key === "mode") pol.mode = ln.value || null;
    else if (ln.key === "maxRetries") pol.maxRetries = scalarNum(ln.value);
    else if (ln.key === "retryableCodes") {
      const codes = [];
      for (let j = i + 1; j < rpEnd; j++) {
        const l = lines[j];
        if (l.empty) continue;
        if (l.indent !== rpIndent + 4) break;
        if (l.isListItem && l.listValue) codes.push(l.listValue);
      }
      pol.retryableCodes = codes;
    } else if (ln.key === "backoff" && ln.value === "") {
      for (let j = i + 1; j < rpEnd; j++) {
        const l = lines[j];
        if (l.empty) continue;
        if (l.indent !== rpIndent + 4) break;
        if (l.key === "initialDelayMs") pol.backoff.initialDelayMs = scalarNum(l.value);
        else if (l.key === "maxDelayMs") pol.backoff.maxDelayMs = scalarNum(l.value);
        else if (l.key === "jitterRatio") pol.backoff.jitterRatio = scalarNum(l.value);
      }
    }
  }
  return pol;
}

/* ---------------- 读取 ---------------- */

/**
 * 读取 settings.yaml 中各 provider 的 retryPolicy 现状。
 * 返回 { file, providers: [{ topKey, providerId, kind, retryPolicy|null }] }
 *   kind: 'pi-ai'（llm-pi-ai.providers.<id>）| 'direct'（顶层段自身即 provider）
 */
function readRetryPolicy(home) {
  const settingsPath = path.join(home, "settings.yaml");
  if (!fs.existsSync(settingsPath)) return { file: settingsPath, providers: [] };
  const lines = fs.readFileSync(settingsPath, "utf8").split(/\r?\n/).map(parseLine);
  const providers = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.empty || ln.isListItem || ln.indent !== 0 || ln.key == null || ln.value !== "") continue;
    const topKey = ln.key;
    const topEnd = blockEnd(lines, i);
    // pi-ai 模式：顶层段 → providers: → <id>:
    for (let j = i + 1; j < topEnd; j++) {
      const pj = lines[j];
      if (!pj.empty && !pj.isListItem && pj.indent === 2 && pj.key === "providers" && pj.value === "") {
        const provEnd = blockEnd(lines, j);
        for (let k = j + 1; k < provEnd; k++) {
          const pk = lines[k];
          if (!pk.empty && !pk.isListItem && pk.indent === 4 && pk.key != null && pk.value === "") {
            const pEnd = blockEnd(lines, k);
            providers.push({ topKey, providerId: pk.key, kind: "pi-ai", retryPolicy: parseRetryPolicy(lines, k, pEnd) });
          }
        }
        break;
      }
    }
    // direct 模式：顶层段下直接有 retryPolicy
    const hasDirect = lines.slice(i + 1, topEnd).some((l) => !l.empty && !l.isListItem && l.indent === 2 && l.key === "retryPolicy");
    if (hasDirect && !providers.some((p) => p.topKey === topKey && p.kind === "direct")) {
      providers.push({ topKey, providerId: topKey, kind: "direct", retryPolicy: parseRetryPolicy(lines, i, topEnd) });
    }
  }
  return { file: settingsPath, providers };
}

/* ---------------- 写入 ---------------- */

/** 生成 retryPolicy 块的行序列（indent 为 retryPolicy 键的缩进）。 */
function buildRetryLines(indent, policy) {
  const pad = " ".repeat(indent);
  const pad2 = " ".repeat(indent + 2);
  const pad4 = " ".repeat(indent + 4);
  const out = [`${pad}retryPolicy:`];
  out.push(`${pad2}mode: ${policy.mode}`);
  const b = policy.backoff || {};
  out.push(`${pad2}backoff:`);
  if (b.initialDelayMs != null) out.push(`${pad4}initialDelayMs: ${b.initialDelayMs}`);
  if (b.maxDelayMs != null) out.push(`${pad4}maxDelayMs: ${b.maxDelayMs}`);
  if (b.jitterRatio != null) out.push(`${pad4}jitterRatio: ${b.jitterRatio}`);
  if (policy.mode === "normal") {
    if (policy.maxRetries != null) out.push(`${pad2}maxRetries: ${policy.maxRetries}`);
    if (policy.retryableCodes && policy.retryableCodes.length) {
      out.push(`${pad2}retryableCodes:`);
      for (const c of policy.retryableCodes) out.push(`${pad4}- ${c}`);
    }
  }
  return out;
}

/**
 * 更新 settings.yaml 中指定 provider 的 retryPolicy。
 * @param {string} home 数据目录
 * @param {{ topKey:string, providerId:string, retryPolicy:object }} arg
 * @returns {{ file, provider, written:number }}
 */
function writeRetryPolicy(home, { topKey, providerId, retryPolicy }) {
  if (!topKey || !providerId) throw new Error("缺少 topKey / providerId");
  if (!retryPolicy || typeof retryPolicy !== "object") throw new Error("缺少 retryPolicy 配置");
  if (!MODES.includes(retryPolicy.mode)) throw new Error(`mode 仅支持 ${MODES.join(" | ")}`);
  const b = retryPolicy.backoff || {};
  const isNum = (v) => Number.isFinite(v);
  if (isNum(b.initialDelayMs) && (!Number.isInteger(b.initialDelayMs) || b.initialDelayMs <= 0 || b.initialDelayMs > MAX_DELAY_MS)) throw new Error("initialDelayMs 需为 1 ~ 2147483647 的整数(ms)");
  if (isNum(b.maxDelayMs) && (!Number.isInteger(b.maxDelayMs) || b.maxDelayMs <= 0 || b.maxDelayMs > MAX_DELAY_MS)) throw new Error("maxDelayMs 需为 1 ~ 2147483647 的整数(ms)");
  if (isNum(b.jitterRatio) && (b.jitterRatio < 0 || b.jitterRatio > 1)) throw new Error("jitterRatio 需在 0 ~ 1 之间");
  if (isNum(b.initialDelayMs) && isNum(b.maxDelayMs) && b.initialDelayMs > b.maxDelayMs) throw new Error("initialDelayMs 需小于等于 maxDelayMs（harness 硬校验，违反会导致该 provider 模型不可用）");
  if (retryPolicy.mode === "normal") {
    if (isNum(retryPolicy.maxRetries) && (!Number.isInteger(retryPolicy.maxRetries) || retryPolicy.maxRetries < 0)) throw new Error("maxRetries 需为非负整数");
    if (retryPolicy.retryableCodes != null && !Array.isArray(retryPolicy.retryableCodes)) throw new Error("retryableCodes 需为字符串数组");
  }

  const settingsPath = path.join(home, "settings.yaml");
  if (!fs.existsSync(settingsPath)) throw new Error("settings.yaml 不存在，请先运行 dsh（或 doctor 修复生成）");
  const raw = fs.readFileSync(settingsPath, "utf8");
  const lines = raw.split(/\r?\n/).map(parseLine);
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";

  // 定位目标 provider 块
  let target = null;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.empty || ln.isListItem || ln.indent !== 0 || ln.key == null || ln.value !== "") continue;
    if (ln.key !== topKey) continue;
    const topEnd = blockEnd(lines, i);
    for (let j = i + 1; j < topEnd; j++) {
      const pj = lines[j];
      if (!pj.empty && !pj.isListItem && pj.indent === 2 && pj.key === "providers" && pj.value === "") {
        const provEnd = blockEnd(lines, j);
        for (let k = j + 1; k < provEnd; k++) {
          const pk = lines[k];
          if (!pk.empty && !pk.isListItem && pk.indent === 4 && pk.key === providerId && pk.value === "") {
            target = { start: k, end: blockEnd(lines, k), base: pk.indent };
            break;
          }
        }
        break;
      }
    }
    if (!target && providerId === topKey) target = { start: i, end: topEnd, base: ln.indent };
    if (target) break;
  }
  if (!target) throw new Error(`settings.yaml 中未找到 provider「${topKey}${providerId === topKey ? "" : "." + providerId}」，请先在 dsh web 的“设置 → 模型”中添加提供方`);

  const newBlock = buildRetryLines(target.base + 2, { ...retryPolicy, backoff: b });
  let rp = -1, rpEnd = -1;
  for (let i = target.start + 1; i < target.end; i++) {
    if (!lines[i].empty && lines[i].indent === target.base + 2 && lines[i].key === "retryPolicy") { rp = i; rpEnd = blockEnd(lines, i); break; }
  }

  const out = [];
  if (rp >= 0) {
    out.push(lines.slice(0, rp).map((l) => l.raw), newBlock, lines.slice(rpEnd).map((l) => l.raw));
  } else {
    out.push(lines.slice(0, target.end).map((l) => l.raw), newBlock, lines.slice(target.end).map((l) => l.raw));
  }
  const text = out.flat().join(eol);

  // 备份后写回
  fs.copyFileSync(settingsPath, settingsPath + ".retry-bak");
  fs.writeFileSync(settingsPath, text, "utf8");
  return { file: settingsPath, provider: { topKey, providerId }, written: newBlock.length };
}

module.exports = { readRetryPolicy, writeRetryPolicy, MODES, DEFAULT_RETRYABLE };
