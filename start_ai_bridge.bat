@echo off
title Octarine AI Chat Responder Bridge
cd /d "%~dp0"

echo =========================================================
echo    Octarine AI Chat Responder - Local Sidecar Bridge
echo =========================================================
echo Starting AI Bridge...
echo.

call npm run ai-bridge

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] AI Bridge stopped with error code %ERRORLEVEL%.
    pause
)
