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
REM Zapuskaem realnyj kod, a ne "--version": zaglushka iz Microsoft Store
REM pechataet slovo "Python" bez nomera versii i vyhodit s oshibkoj.
python -c "import sys; print('PYOK', sys.version.split()[0])" > "%TEMP%\zw_py.txt" 2>>"%LOG%"
if errorlevel 1 goto nopython
find "PYOK" "%TEMP%\zw_py.txt" >nul 2>&1
if errorlevel 1 goto fakepython
for /f "tokens=2" %%v in ('type "%TEMP%\zw_py.txt"') do echo       OK: Python %%v
type "%TEMP%\zw_py.txt" >> "%LOG%"

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

:fakepython
echo.
echo [OSHIBKA] Vmesto Python otvechaet zaglushka Microsoft Store.
echo Nastojashhij Python napisal by nomer versii, a eta - net.
echo.
echo Chto delat:
echo   1. Parametry - Prilozhenija - Dopolnitelnye parametry prilozhenija
echo      - Psevdonimy vypolnenija prilozhenija
echo   2. Vykljuchi polzunki u python.exe i python3.exe
echo   3. Postav nastojashhij Python s https://www.python.org/downloads/
echo      s galkoj "Add python.exe to PATH"
echo   4. Perezagruzi kompjuter i zapusti etot .bat snova
echo.
echo Proverit chem prikidyvaetsja: v cmd nabrat   where python
goto fail

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
