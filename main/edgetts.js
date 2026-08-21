// main/edgetts.js — Edge TTS 主进程服务（微软神经网络语音，免费，调 python edge-tts CLI）
// 降级链：Edge TTS → 智谱 TTS(渲染进程) → 系统 speechSynthesis
// 音色：晓伊 zh-CN-XiaoyiNeural（活泼甜美年轻女声）
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// 可用中文音色（设置面板下拉用）
const VOICES = [
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊（甜美活泼）' },
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓（温暖亲切）' },
  { id: 'zh-CN-xiaochenNeural', label: '晓辰（阳光邻家）' },
  { id: 'zh-CN-XiaohanNeural', label: '晓涵（温柔甜美）' },
  { id: 'zh-CN-XiaomengNeural', label: '晓梦（轻柔可爱）' },
  { id: 'zh-CN-XiaomoNeural', label: '晓墨（灵动百变）' },
  { id: 'zh-CN-XiaoqiuNeural', label: '晓秋（温柔坚毅）' },
  { id: 'zh-CN-XiaoruiNeural', label: '晓睿（成熟稳重）' },
  { id: 'zh-CN-XiaoshuangNeural', label: '晓双（天真童声）' },
  { id: 'zh-CN-XiaoyanNeural', label: '晓颜（甜美灵动）' },
  { id: 'zh-CN-YunxiNeural', label: '云希（阳光少年）' },
  { id: 'zh-CN-YunyangNeural', label: '云扬（磁性播音）' },
];

const TMP_DIR = path.join(os.tmpdir(), 'pet-edgetts');
// 注意：Electron 主进程与 shell 的 /tmp 可能解析到不同沙箱视图，
// 每次合成前都 ensureDir（幂等，开销可忽略）
function ensureTmpDir() {
  try { fs.mkdirSync(TMP_DIR, { recursive: true }); } catch { /* ignore */ }
}
try { fs.mkdirSync(TMP_DIR, { recursive: true }); } catch { /* ignore */ }

// python 解释器候选（WorkBuddy 自带 python 优先，系统 python3 兜底）
const PYTHON_CANDIDATES = [
  process.env.PET_EDGE_TTS_PYTHON,
  '/Users/mac/.workbuddy/binaries/python/versions/3.13.12/bin/python3',
  'python3',
].filter(Boolean);

let cachedPython = null;

/** 找一个带 edge_tts 的 python */
async function findPython() {
  if (cachedPython) return cachedPython;
  for (const py of PYTHON_CANDIDATES) {
    const ok = await new Promise((resolve) => {
      execFile(py, ['-c', 'import edge_tts'], { timeout: 5000 }, (err) => resolve(!err));
    });
    if (ok) { cachedPython = py; return py; }
  }
  throw new Error('未找到带 edge_tts 的 python（pip3 install edge-tts）');
}

/** 单次合成（python 子进程） */
function synthOnce(py, text, voice, rate, pitch, outFile) {
  const args = ['-c', `
import asyncio, edge_tts, sys
async def main():
    c = edge_tts.Communicate(sys.argv[1], sys.argv[2], rate=sys.argv[3], pitch=sys.argv[4])
    await c.save(sys.argv[5])
asyncio.run(main())
`, text, voice, rate, pitch, outFile];
  return new Promise((resolve, reject) => {
    execFile(py, args, { timeout: 30000, maxBuffer: 1024 * 512 }, (err, _so, se) => {
      if (err) reject(new Error(`edge-tts: ${String(se || err.message).slice(0, 150)}`));
      else resolve();
    });
  });
}

/**
 * 合成语音到临时 mp3 文件（网络抖动自动重试1次）
 * @returns {Promise<string>} mp3 文件绝对路径（失败抛错）
 */
async function synthesize(text, voice = 'zh-CN-XiaoyiNeural', opts = {}) {
  const clean = String(text || '').trim().slice(0, 600);
  if (!clean) throw new Error('空文本');
  ensureTmpDir(); // 主进程 /tmp 视图可能与 shell 不同，每次确保存在
  const py = await findPython();
  const rate = typeof opts.rate === 'number' ? `${opts.rate > 0 ? '+' : ''}${Math.round(opts.rate * 100)}%` : '+0%';
  const pitch = typeof opts.pitch === 'number' ? `${opts.pitch > 0 ? '+' : ''}${Math.round(opts.pitch)}Hz` : '+0Hz';

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const outFile = path.join(TMP_DIR, `tts-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.mp3`);
    try {
      await synthOnce(py, clean, voice, rate, pitch, outFile);
      // 校验产物
      const st = fs.statSync(outFile);
      if (st.size < 500) throw new Error('音频过小');
      return outFile;
    } catch (e) {
      lastErr = e;
      try { fs.unlinkSync(outFile); } catch { /* ignore */ }
      if (attempt === 0) await new Promise(r => setTimeout(r, 800)); // 重试前歇一下
    }
  }
  throw lastErr || new Error('edge-tts 合成失败');
}

/** 读取 mp3 为 base64 并删除临时文件 */
function readAndCleanup(file) {
  try {
    const buf = fs.readFileSync(file);
    fs.unlink(file, () => { });
    return buf.toString('base64');
  } catch (e) {
    throw new Error('读取 TTS 音频失败: ' + e.message);
  }
}

/** 清理超过10分钟的残留临时文件（防 tmp 膨胀） */
function cleanupOld() {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(TMP_DIR)) {
      const p = path.join(TMP_DIR, f);
      try { if (now - fs.statSync(p).mtimeMs > 10 * 60 * 1000) fs.unlinkSync(p); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

// 当前播放的 afplay 子进程（打断时 kill）
let playingProc = null;

function initEdgeTTSIPC(ipcMain) {
  // 合成：{text, voice, rate, pitch} → {ok, audioBase64} | {ok:false, error}
  ipcMain.handle('edge-tts-synth', async (_e, payload = {}) => {
    try {
      cleanupOld();
      const file = await synthesize(payload.text, payload.voice, payload);
      return { ok: true, audioBase64: readAndCleanup(file) };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err).slice(0, 200) };
    }
  });

  // 合成+系统播放（afplay）：渲染进程 <audio> 解码 mp3 在部分环境不可用 →
  // 主进程直接 afplay 播放（macOS 原生，稳定）。返回 {ok, played, interrupted}
  // 播放时长用于口型对齐（按文本长度估算：字数×0.22s，afplay 完成即返回）
  ipcMain.handle('edge-tts-play', async (_e, payload = {}) => {
    try {
      cleanupOld();
      const text = String(payload.text || '').trim().slice(0, 600);
      if (!text) return { ok: false, error: '空文本' };
      const file = await synthesize(text, payload.voice, payload);
      const played = await new Promise((resolve) => {
        const { spawn } = require('child_process');
        const proc = spawn('afplay', [file], { stdio: 'ignore' });
        playingProc = proc;
        let settled = false;
        const done = (interrupted) => {
          if (settled) return;
          settled = true;
          if (playingProc === proc) playingProc = null;
          try { fs.unlinkSync(file); } catch { /* ignore */ }
          resolve({ full: !interrupted, interrupted: !!interrupted });
        };
        proc.on('exit', (code, signal) => done(signal === 'SIGTERM' || signal === 'SIGKILL'));
        proc.on('error', () => done(false));
        // 60s 安全兜底（长文本）
        setTimeout(() => { try { proc.kill('SIGTERM'); } catch { /* ignore */ } }, 60000).unref?.();
      });
      return { ok: true, played: true, interrupted: played.interrupted, estMs: Math.max(1500, text.length * 220) };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err).slice(0, 200) };
    }
  });

  // 停止当前 afplay 播放（语音打断用）
  ipcMain.handle('edge-tts-stop', async () => {
    const proc = playingProc;
    playingProc = null;
    if (proc) {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      return { ok: true, stopped: true };
    }
    return { ok: true, stopped: false };
  });

  // 音色列表（设置面板）
  ipcMain.handle('edge-tts-voices', () => VOICES);
}

module.exports = { initEdgeTTSIPC, synthesize, VOICES };
