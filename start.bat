@echo off
chcp 65001 >nul
title dsh_manager - DeepSeek Harness 管理器
cd /d "%~dp0"

rem ---- 启动前必要环境预检：node 是运行 dsh_manager 本身的前提，缺了就引导安装 ----
where node >nul 2>nul
if errorlevel 1 (
  echo ============================================================
  echo  [错误] 未检测到 Node.js。dsh_manager 依赖 Node.js 才能运行。
  echo  请先安装 Node.js（推荐 22 LTS 或 24）：
  echo    · winget:  winget install OpenJS.NodeJS.LTS
  echo    · 官方下载: https://nodejs.org/zh-cn/download
  echo  ============================================================
  start https://nodejs.org/zh-cn/download
  pause
  exit /b 1
)

echo 正在启动 dsh_manager ...
set "DSH_MANAGER_OPEN_BROWSER=1"
node "%~dp0server.js"
if errorlevel 1 pause
