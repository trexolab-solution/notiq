@echo off
cd /d "%~dp0"
del /q /s .git\*.lock 2>nul
git add docs > pages-result.log 2>&1
git commit -F commit-msg.txt >> pages-result.log 2>&1
git push origin main >> pages-result.log 2>&1
git log --oneline -2 >> pages-result.log
exit
