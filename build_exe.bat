@echo off
echo === Zoom Hand Spammer - Build EXE ===
echo.

where python >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python ne najden! Ustanovi Python s python.org
    pause
    exit /b 1
)

echo Ustanovka zavisimostej...
pip install pyautogui pyinstaller

echo.
echo Sborka EXE...
pyinstaller --onefile --windowed --name "ZoomHandSpammer" zoom_hand_spammer.py

echo.
echo === GOTOVO! ===
echo EXE lezit v papke: dist\ZoomHandSpammer.exe
echo.
pause
