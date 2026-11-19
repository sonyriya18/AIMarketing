@echo off
title Oracle AI Platform - Setup (run once)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\setup.ps1"
if errorlevel 1 pause
