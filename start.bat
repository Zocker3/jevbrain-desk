@echo off
REM Jev Brain Desk launcher (Windows)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20+ is required: https://nodejs.org/
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies...
  call npm install --omit=dev
)
node src\server.js %*
pause
