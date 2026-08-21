#!/bin/bash
# restart-pet.sh — 彻底重启小球：杀光本项目所有 Electron 进程（含孤儿 Helper）
# 与残留 afplay（Edge TTS），确保零残留后启动新实例
cd "$(dirname "$0")"

# 1) 杀本项目 electron 全家（主进程+GPU/Renderer/Utility Helper，含孤儿）
pkill -9 -f "desktop-pet/node_modules/electron" 2>/dev/null
# 2) 杀残留 TTS 播放（主进程被 -9 后 afplay 会变孤儿继续出声！）
pkill -9 -f "afplay /.*pet-edgetts" 2>/dev/null
pkill -9 -f "afplay.*tts-" 2>/dev/null
sleep 1

# 3) 校验清零
LEFT=$(ps aux | grep "desktop-pet/node_modules/electron" | grep -v grep | wc -l | tr -d ' ')
if [ "$LEFT" != "0" ]; then
  echo "警告：仍有 $LEFT 个残留进程，再杀一轮"
  pkill -9 -f "desktop-pet/node_modules/electron" 2>/dev/null
  sleep 1
fi

# 4) 启动（日志带时间戳）
LOG="/tmp/pet-ball-$(date +%H%M%S).log"
PET_BALL=1 nohup env -u ELECTRON_RUN_AS_NODE npx electron . --remote-debugging-port=9240 > "$LOG" 2>&1 &
echo "已启动（日志: $LOG）"

# 5) 等就绪
for i in $(seq 1 10); do
  sleep 1
  if curl -s --max-time 2 http://127.0.0.1:9240/json/version >/dev/null 2>&1; then
    echo "就绪 ✓"
    exit 0
  fi
done
echo "启动超时，查日志: $LOG"
exit 1
