@echo off
setlocal
start "ProbablyFae Setup" /wait powershell.exe -NoExit -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
