@echo off
rem 每日执行入口（由计划任务调用，也可手动双击运行）
cd /d "%~dp0"
if not exist logs mkdir logs
echo. >> logs\flow.log
echo ===== %date% %time% ===== >> logs\flow.log
node auto_flow.js >> logs\flow.log 2>&1
