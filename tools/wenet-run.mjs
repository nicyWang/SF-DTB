// wenet-run.mjs — wav→log_mel(JS)→wenet encoder(onnxruntime-node)→BNF特征(帧×256)存bin
// 参数完全对齐 duix-sdk cpp/aisdk/mfcc/mfcc.hpp + wenet.cpp
import ort from 'onnxruntime-node';
import { readFileSync, writeFileSync } from 'node:fs';

const SR = 16000, N_FFT = 1024, HOP = 160, WIN = 800, N_MELS = 80;
const PREEMPH = 0.97, REF_DB = 20;

// ---- wav解析（16bit PCM mono）----
function readWav(fn) {
  const b = readFileSync(fn);
  // 找data块
  let off = 12;
  while (off < b.length - 8) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'data') {
      const n = size >> 1;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = b.readInt16LE(off + 8 + i * 2) / 32768;
      return out;
    }
    off += 8 + size + (size & 1);
  }
  throw new Error('no data chunk');
}

// ---- mel滤波器组（librosa风格，对齐mfcc.hpp hz_to_mel）----
function hzToMel(f) { return f / 200 * 3; } // f_sp=200/3线性（对齐源码非htk分支）
function melFilterbank() {
  const nFftBins = N_FFT / 2 + 1;
  const melPts = new Float64Array(N_MELS + 2);
  const melMin = hzToMel(0), melMax = hzToMel(SR / 2);
  for (let i = 0; i < N_MELS + 2; i++) melPts[i] = melMin + (melMax - melMin) * i / (N_MELS + 1);
  const hzPts = Array.from(melPts, m => 200 / 3 * m); // 线性反变换（源码线性区）
  const bins = Array.from(hzPts, hz => Math.floor((N_FFT + 1) * hz / SR));
  const fbank = Array.from({ length: N_MELS }, () => new Float64Array(nFftBins));
  for (let m = 1; m <= N_MELS; m++) {
    for (let k = bins[m - 1]; k < bins[m]; k++) if (k < nFftBins && bins[m] !== bins[m - 1]) fbank[m - 1][k] = (k - bins[m - 1]) / (bins[m] - bins[m - 1]);
    for (let k = bins[m]; k < bins[m + 1]; k++) if (k < nFftBins && bins[m + 1] !== bins[m]) fbank[m - 1][k] = (bins[m + 1] - k) / (bins[m + 1] - bins[m]);
  }
  return fbank;
}

// ---- radix-2 FFT（实数输入用复数FFT）----
function fftRadix2(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

// ---- log_mel（对齐源码：preemphasis→|STFT|²→mel→log→*10/log10→-ref_db）----
function logMel(pcm) {
  // 预加重
  const emph = new Float32Array(pcm.length);
  emph[0] = pcm[0];
  for (let i = 1; i < pcm.length; i++) emph[i] = pcm[i] - pcm[i - 1] * PREEMPH;
  // hann窗
  const win = new Float64Array(WIN);
  for (let i = 0; i < WIN; i++) win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (WIN - 1)));
  // 帧
  const nFrames = Math.max(0, Math.floor((emph.length - WIN) / HOP) + 1);
  const nBins = N_FFT / 2 + 1;
  const fbank = melFilterbank();
  const mel = new Float32Array(nFrames * N_MELS);
  const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT);
  for (let f = 0; f < nFrames; f++) {
    re.fill(0); im.fill(0);
    for (let i = 0; i < WIN; i++) re[i] = emph[f * HOP + i] * win[i];
    fftRadix2(re, im);
    // 功率谱 → mel
    for (let m = 0; m < N_MELS; m++) {
      let s = 0;
      for (let k = 0; k < nBins; k++) {
        const p = re[k] * re[k] + im[k] * im[k];
        s += fbank[m][k] * p;
      }
      // log → dB（对齐源码: log(x+1e-5)*10/log(10) - ref_db）
      mel[f * N_MELS + m] = (Math.log(s + 1e-5) / 2.3025850929940459 * 10) - REF_DB;
    }
  }
  return mel; // [nFrames × 80]
}

// ---- 主流程 ----
async function main() {
  const wavFn = process.argv[2];
  const modelFn = process.argv[3] || '/tmp/wenet.onnx';
  const outFn = process.argv[4] || '/tmp/bnf.bin';
  if (!wavFn) { console.error('用法: node wenet-run.mjs <in.wav> [model.onnx] [out.bnf.bin]'); process.exit(1); }

  // 1) wav → 前后各pad MFCC_OFFSET=6400 样本（对齐源码 m_pcmsample = wavsample + 2*MFCC_OFFSET）
  const OFFSET = 6400;
  const pcm0 = readWav(wavFn);
  const pcm = new Float32Array(OFFSET * 2 + pcm0.length);
  pcm.set(pcm0, OFFSET);
  console.log('wav:', pcm0.length, 'samples', (pcm0.length / 16).toFixed(0) + 'ms');

  // 2) log_mel（MFCC_WAVCHUNK分块=560000样本，短音频一块）
  const mel = logMel(pcm);
  const T = mel.length / N_MELS;
  console.log('mel:', T, '帧×', N_MELS);

  // 3) wenet encoder：speech[1,T,80] + speech_lengths[1] → encoder_out[1,T_OUT,256]
  const session = await ort.InferenceSession.create(modelFn);
  const speech = new ort.Tensor('float32', mel, [1, T, N_MELS]);
  const lengths = new ort.Tensor('int32', Int32Array.from([T]), [1]);
  const out = await session.run({ speech, speech_lengths: lengths });
  const enc = out.encoder_out || Object.values(out)[0];
  console.log('encoder_out:', enc.dims.join('×'), '类型', enc.type);

  // 4) 存bin（float32帧×256）
  writeFileSync(outFn, Buffer.from(enc.data.buffer, enc.data.byteOffset, enc.data.byteLength));
  console.log('BNF特征:', enc.dims[1], '帧×256 →', outFn);
}
main().catch(e => { console.error('失败:', e.message); process.exit(1); });