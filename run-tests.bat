@echo off
cd /d "%~dp0"
call bun run test > test-result.log 2>&1
echo EXIT_CODE %ERRORLEVEL% >> test-result.log
exit
