@echo off
chcp 65001 >nul
title dsh_manager - DeepSeek Harness 管理器
cd /d "%~dp0"
echo 正在启动 dsh_manager ...
set "DSH_MANAGER_OPEN_BROWSER=1"
node "%~dp0server.js"
if errorlevel 1 pause
