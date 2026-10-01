@echo off
chcp 65001 >nul
rem Этап 3: выносит первые N фрагментов редактора в папку export\ -
rem клипы (H.265 в исходном 4K, точно по границам) и их тексты.
rem Вынесенные фрагменты пропадают из редактора, и пересборка этапа 1
rem их больше не трогает. Номер N - как в редакторе (N / всего).
rem
rem Необязательный первый аргумент - папка проекта (data\<id>).

cd /d "%~dp0"
set "PROJECT_DIR=%~1"
rem Без аргумента - последнее обработанное видео (data\current_project.txt).
rem Другое видео: перетащите его папку из data\ на этот файл.
if "%PROJECT_DIR%"=="" if exist "data\current_project.txt" set /p PROJECT_DIR=<"data\current_project.txt"
if "%PROJECT_DIR%"=="" set "PROJECT_DIR=gTKS8SAwUzE"
if not exist "%PROJECT_DIR%\manifest.json" if exist "data\%PROJECT_DIR%\manifest.json" set "PROJECT_DIR=data\%PROJECT_DIR%"

if not exist "%PROJECT_DIR%\manifest.json" (
    echo Не найден проект: %PROJECT_DIR%
    pause
    exit /b 1
)

set "THROUGH="
set /p "THROUGH=До какого фрагмента включительно вынести на этап 3 (номер в редакторе): "
if "%THROUGH%"=="" exit /b 0

rem Редактор закрывается на время выгрузки, чтобы не править те же фрагменты.
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*-m webapp.run*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

py -3.12 -m phase3_export.export_clips --project-dir "%PROJECT_DIR%" --through %THROUGH%
if errorlevel 1 (
    echo.
    echo Выгрузка не удалась.
    pause
    exit /b 1
)
echo.
echo Готово. Клипы и тексты - в %PROJECT_DIR%\export
pause
call "%~dp0open_editor.bat" "%PROJECT_DIR%"
exit /b 0
