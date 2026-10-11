@echo off
cd /d "%~dp0"
set "LOG=%~dp0build-log.txt"
echo === ZoomWar build log === > "%LOG%"

echo ==============================
echo     ZoomWar - sborka EXE
echo ==============================
echo.
echo Podrobnyj log pishetsja v build-log.txt
echo.

if not exist "zoomwar.py" (
    echo [OSHIBKA] V etoj papke net fajla zoomwar.py
    echo Polozhi zoomwar.py ryadom s etim .bat i zapusti snova.
    goto fail
)

echo [1/3] Proverjaju Python...
python --version >> "%LOG%" 2>&1
if errorlevel 1 goto nopython
for /f "delims=" %%v in ('python --version 2^>^&1') do echo       OK: %%v

echo [2/3] Stavlju zavisimosti, eto dolgo - zhdi...
python -m pip install --upgrade pip >> "%LOG%" 2>&1
python -m pip install pyautogui selenium webdriver-manager pyinstaller >> "%LOG%" 2>&1
if errorlevel 1 (
    echo [OSHIBKA] Zavisimosti ne postavilis. Otkroj build-log.txt
    goto fail
)
echo       OK

echo [3/3] Sobiraju EXE, minuty 2-3 - ne zakryvaj okno...
REM "python -m PyInstaller", a ne prosto "pyinstaller":
REM posle svezhej ustanovki pyinstaller.exe chasto eshhjo net v PATH.
python -m PyInstaller --onefile --windowed --name "ZoomWar" zoomwar.py >> "%LOG%" 2>&1
if errorlevel 1 (
    echo [OSHIBKA] Sborka upala. Otkroj build-log.txt
    goto fail
)

if not exist "dist\ZoomWar.exe" (
    echo [OSHIBKA] EXE ne pojavilsja. Otkroj build-log.txt
    goto fail
)

echo.
echo ==============================
echo            GOTOVO
echo ==============================
echo EXE lezit tut: %~dp0dist\ZoomWar.exe
echo.
echo V Soundpad vkljuchi Remote control:
echo   Settings -^> Remote control -^> Allow remote control
echo.
pause
exit /b 0

:nopython
echo.
echo [OSHIBKA] Python ne najden.
echo.
echo Chto delat:
echo   1. Skachaj Python s https://www.python.org/downloads/
echo   2. PRI USTANOVKE POSTAV GALKU "Add python.exe to PATH"
echo      ^(ona vnizu pervogo okna ustanovshhika, ejo legko propustit^)
echo   3. Perezapusti kompjuter, potom zapusti etot .bat snova
echo.
echo Esli Python stoit iz Microsoft Store - udali ego
echo i postav obychnyj s python.org, so Store sborka ne druzhit.
goto fail

:fail
echo.
echo ------------------------------
echo Okno ne zakroetsja samo. Prochitaj tekst vyshe.
pause
exit /b 1
