@echo off
title VoxScribe Live Audio-to-Text Server
echo Starting VoxScribe Speech-to-Text Web Application...
powershell -ExecutionPolicy Bypass -File "%~dp0server.ps1"
pause

