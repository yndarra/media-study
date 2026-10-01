@echo off
chcp 65001 >nul
rem Скачивает (в 2K) и перекодирует сюжетные видео Wuthering Waves (Main Quest):
rem первые 5 и последние 5 из плейлиста. Готовые пропускаются - можно запускать повторно.
rem Если места на диске мало, очередь останавливается сама; освободите место и запустите снова.
cd /d "%~dp0"
py -3.12 -m phase1_ingest.batch_prepare "https://www.youtube.com/playlist?list=PLZnOVgA_jMslOsVp7hMlOuwHDFaDeLsgZ" --match "Main Quest" --group "Wuthering Waves" --first 5 --last 5 --max-height 1440 --gb-per-hour 10
pause
