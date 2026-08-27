"use strict";
/*
 * dsh_manager · 插件管理模块（零第三方依赖）
 *
 * 管理 dsh 生态的外部插件机制：Profile 插件（组合包 bundle）。
 * 这是 dsh 当前唯一官方的外部插件分发路径，直接读写
 * $DSH_HOME/profiles/<name>/package.json，不触碰源码工作树（repoPath）。
 *
 * 写前一律备份为 `*.manager-bak`（沿用 retry.js 的 `.retry-bak` 范式）。
 * 涉及 pnpm / CLI（真正的安装与卸载）不在本文件内执行，由 server.js 以
 * activeTask + 内置 CLI 转发；本文件提供纯文件 CRUD 与退化回退（direct edit）。
 *
 * 注：早期版本曾存在「Repository 插件（.dsh-plugin）」机制，已在 dsh harness
 *     中移除并失效，故本模块不含任何 repository 相关逻辑。
 */

const fs = require("fs");
const path = require("path");

/* ================= 通用 ================= */

function backupFile(p) {
  if (fs.existsSync(p)) fs.copyFileSync(p, p + ".manager-bak");
}

/* ================= Profile 插件 ================= */

function profilesDir(home) { return path.join(home, "profiles"); }

/** 列出已初始化的 profile 名（存在 profiles/<name>/package.json）。 */
function listProfiles(home) {
  const pdir = profilesDir(home);
  const out = [];
  if (!fs.existsSync(pdir)) return out;
  let names = [];
  try { names = fs.readdirSync(pdir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return out; }
  for (const name of names) {
    const dir = path.join(pdir, name);
    if (!fs.existsSync(path.join(dir, "package.json"))) continue;
    const pkg = readPkg(dir);
    out.push({ name, dir, template: pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.template });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  return out;
}

function readPkg(dir) {
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); } catch { /* 忽略损坏文件 */ }
  return pkg;
}
function writePkg(dir, pkg) {
  const file = path.join(dir, "package.json");
  backupFile(file);
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n", "utf8");
}

/** 列出某 profile 的依赖与 bundle 插件。 */
function listProfilePlugins(home, profile) {
  const dir = path.join(profilesDir(home), profile);
  if (!fs.existsSync(path.join(dir, "package.json"))) {
    throw new Error(`profile「${profile}」不存在（${dir}）`);
  }
  const pkg = readPkg(dir);
  const bundles = Array.isArray(pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
  const deps = pkg.dependencies || {};
  const plugins = Object.keys(deps).map((name) => {
    const spec = deps[name];
    const isLink = /^(link|file):/i.test(spec);
    return { pkg: name, spec, kind: isLink ? "link" : "official", enabled: bundles.includes(name) };
  });
  plugins.sort((a, b) => a.pkg.localeCompare(b.pkg, "zh"));
  return { profile, dir, dependencies: Object.keys(deps), bundles, plugins };
}

/** 直接改名 package.json 的 bundle 层列表（启用/关闭），不删依赖。 */
function setProfilePluginEnabled(home, { profile, pkg: pkgName, enabled }) {
  if (!pkgName) throw new Error("缺少包名");
  const profileObj = listProfiles(home).find((p) => p.name === profile);
  if (!profileObj) throw new Error(`profile「${profile}」不存在`);
  const dir = profileObj.dir;
  const pkg = readPkg(dir);
  if (!(pkg.dependencies || {})[pkgName]) throw new Error(`依赖中不存在包「${pkgName}」，请先添加`);
  const bundles = Array.isArray(pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
  const inList = bundles.includes(pkgName);
  if (inList === enabled) return { profile, pkg: pkgName, enabled, noChange: true };
  if (enabled) { bundles.push(pkgName); }
  else { const i = bundles.indexOf(pkgName); if (i >= 0) bundles.splice(i, 1); }
  pkg.dsh = { ...(pkg.dsh || {}), profile: { ...(pkg.dsh && pkg.dsh.profile), bundles } };
  writePkg(dir, pkg);
  return { profile, pkg: pkgName, enabled, noChange: false };
}

/**
 * 直接改 package.json 追加依赖 + 按需加入 bundles（作为 CLI 不可用时的退化路径）。
 * 注意：不执行 pnpm install，调用方需提示用户手动 `pnpm install`（或转 pnpm 任务）。
 */
function addProfilePluginDirect(home, { profile, packageSpec, bundle }) {
  const spec = String(packageSpec || "").trim();
  if (!spec) throw new Error("缺少包名/依赖规格");
  if (/[\r\n]/.test(spec)) throw new Error("包名含非法字符");
  const profileObj = listProfiles(home).find((p) => p.name === profile);
  if (!profileObj) throw new Error(`profile「${profile}」不存在`);
  const dir = profileObj.dir;
  const pkg = readPkg(dir);
  const deps = pkg.dependencies || {};
  // 解析包名：'name@1.2.3' / 'name@workspace:*' / 'link:...' / 'file:...' → 取规范名
  const pkgName = specToName(spec);
  if (deps[pkgName]) throw new Error(`包「${pkgName}」已在依赖中`);
  deps[pkgName] = spec;
  pkg.dependencies = deps;
  if (bundle) {
    const bundles = Array.isArray(pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
    if (!bundles.includes(pkgName)) bundles.push(pkgName);
    pkg.dsh = { ...(pkg.dsh || {}), profile: { ...(pkg.dsh && pkg.dsh.profile), bundles } };
  }
  writePkg(dir, pkg);
  return { profile, pkg: pkgName, spec, bundle: !!bundle, needsPnpmInstall: true };
}

/**
 * 直接改 package.json 从 dependencies 与 bundles 都移除（真实卸载的退化路径）。
 * 同样不执行 pnpm install，调用方需提示。
 */
function removeProfilePluginDirect(home, { profile, pkg: pkgName }) {
  if (!pkgName) throw new Error("缺少包名");
  const profileObj = listProfiles(home).find((p) => p.name === profile);
  if (!profileObj) throw new Error(`profile「${profile}」不存在`);
  const dir = profileObj.dir;
  const pkg = readPkg(dir);
  const deps = pkg.dependencies || {};
  delete deps[pkgName];
  pkg.dependencies = deps;
  if (pkg.dsh && Array.isArray(pkg.dsh.profile && pkg.dsh.profile.bundles)) {
    const bundles = pkg.dsh.profile.bundles;
    const i = bundles.indexOf(pkgName);
    if (i >= 0) bundles.splice(i, 1);
  }
  writePkg(dir, pkg);
  return { profile, pkg: pkgName };
}

/** 从依赖规格提取规范包名（用于直接改 JSON 时的键名）。 */
function specToName(spec) {
  let s = spec.replace(/^(link|file):/i, "");
  // 处理 '@scope/name@1.0.0' 形式的 scoped 包
  if (s.startsWith("@")) {
    const m = s.match(/^(@[^/\s]+\/[^/\s@]+)(?:@(.*))?$/);
    if (m) return m[1];
  } else {
    const m = s.match(/^([^/\s@]+(?:@[^/\s@]+)?)(?:@.*)?$/);
    if (m) return m[1];
  }
  return s;
}

module.exports = {
  listProfiles, listProfilePlugins, addProfilePluginDirect,
  removeProfilePluginDirect, setProfilePluginEnabled, specToPkg: specToName,
};