@echo off
REM Double-click this (Windows) to open the Motherlink Agent control panel in your
REM browser. Keep this window open while you want the agent to run. For a
REM hands-off setup, tick "Start at login" in the panel.
cd /d "%~dp0"
node supervisor.mjs
pause
