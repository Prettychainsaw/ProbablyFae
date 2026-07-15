@echo off
setlocal
start "ProbablyFae Bootstrap" /wait powershell.exe -NoExit -NoProfile -ExecutionPolicy Bypass -File "%~dp0bootstrap.ps1"
