@echo off
cd /d "%~dp0"
del /q /s .git\*.lock 2>nul
git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json src/config/app.ts src/config/whatsNew.ts > release-result.log 2>&1
git commit -F commit-msg.txt >> release-result.log 2>&1
git tag v0.5.0 >> release-result.log 2>&1
git push origin main >> release-result.log 2>&1
git push origin v0.5.0 >> release-result.log 2>&1
git log --oneline -2 >> release-result.log
git status -sb >> release-result.log
exit
