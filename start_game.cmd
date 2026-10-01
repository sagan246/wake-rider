@echo off
cd /d "%~dp0"
echo Wake Rider Lab - Lake Oswego is running at http://localhost:8782
echo Keep this window open. Press Ctrl+C to stop.
start "" "http://localhost:8782"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve_game.ps1"
pause
