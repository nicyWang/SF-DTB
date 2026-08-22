#!/bin/bash
# restart-pet.sh — 彻底重启小球：杀光本项目所有 Electron 进程（含孤儿 Helper）
# 与残留 afplay（Edge TTS），确保零残留后启动新实例
cd "$(dirname "$0")"

# 1) 杀本项目 Electron 主进程（保留父 Shell/CLI；主进程退出会带走各 Helper）
PIDS=$(pgrep -f "desktop-pet/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" || true)
if [ -n "$PIDS" ]; then kill $PIDS 2>/dev/null; sleep 1; fi
PIDS=$(pgrep -f "desktop-pet/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" || true)
if [ -n "$PIDS" ]; then kill -9 $PIDS 2>/dev/null; sleep 0.5; fi
# 2) 杀残留 TTS 播放（主进程被 -9 后 afplay 会变孤儿继续出声！）
pkill -9 -f "afplay /.*pet-edgetts" 2>/dev/null
pkill -9 -f "afplay.*tts-" 2>/dev/null
sleep 1

# 3) 校验清零
LEFT=$(pgrep -f "desktop-pet/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" | wc -l | tr -d ' ')
if [ "$LEFT" != "0" ]; then
  echo "警告：仍有 $LEFT 个残留进程，再杀一轮"
  pkill -9 -f "desktop-pet/node_modules/electron" 2>/dev/null
  sleep 1
fi

# 4) 启动（日志带时间戳）
LOG="/tmp/pet-ball-$(date +%H%M%S).log"
env -u ELECTRON_RUN_AS_NODE -u PET_AUTOQUIT_MS -u PET_ROAM_TEST -u PET_SELFTEST -u PET_TEST_SETTINGS -u PET_STUDIO_TEST PET_BALL=1 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . --remote-debugging-port=9240 > "$LOG" 2>&1 &
PET_PID=$!
disown %+ 2>/dev/null || true
echo "已启动（日志: $LOG）"

# 5) 等就绪
for i in $(seq 1 10); do
  sleep 1
  if curl -s --max-time 2 http://127.0.0.1:9240/json/version >/dev/null 2>&1; then
    echo "就绪 ✓"
    echo "$PET_PID" > /tmp/pet-ball.pid
    exit 0
  fi
done
echo "启动超时，查日志: $LOG"
exit 1
