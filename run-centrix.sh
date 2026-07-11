#!/bin/zsh
# CentriX App User 3.6.16 via Wine (virtual desktop + software GL)
export WINEPREFIX="/Volumes/m2/apps/windows/wine-prefix-centrix"
export WINEDEBUG="-all"
export LIBGL_ALWAYS_SOFTWARE=1
WINE="/Applications/Wine Stable.app/Contents/Resources/wine/bin/wine"
EXE="$WINEPREFIX/drive_c/users/pat/AppData/Local/Programs/CentriX App User/CentriX App User.exe"
exec "$WINE" explorer /desktop=CentriX,1440x900 "$EXE" \
  --disable-gpu --disable-gpu-compositing --disable-gpu-sandbox \
  --in-process-gpu --use-angle=swiftshader --use-gl=swiftshader \
  --no-sandbox "$@"
