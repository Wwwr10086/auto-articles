@echo off
chcp 65001 >nul
rem 注册 Windows 计划任务：每天固定时间自动执行流程
rem 想改执行时间：修改下面 RUN_TIME 后，重新运行本文件即可
set RUN_TIME=08:00
set TASK_NAME=ZidongAutoFlow

schtasks /create /tn "%TASK_NAME%" /tr "\"%~dp0run_daily.bat\"" /sc daily /st %RUN_TIME% /f

echo.
echo 计划任务已注册: %TASK_NAME%  (每天 %RUN_TIME% 执行)
echo 查看任务:   schtasks /query /tn %TASK_NAME% /v
echo 删除任务:   schtasks /delete /tn %TASK_NAME% /f
echo 手动跑一次: schtasks /run /tn %TASK_NAME%
pause
