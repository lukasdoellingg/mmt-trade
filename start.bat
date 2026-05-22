@echo off
set ANTHROPIC_BASE_URL=http://localhost:1234/v1
set ANTHROPIC_AUTH_TOKEN=ollama
set ANTHROPIC_API_KEY=ollama

:: Wechsel zum Projekt
cd /d "E:\-Programme-\mmt-trade\mmt-trade"

:: Start mit angepasstem Modellnamen
claude --model qwen3-esper3-reasoning-coder-instruct-7b

pause