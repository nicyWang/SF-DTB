import { cdp } from './cdp-helper.mjs';
import { execSync } from 'node:child_process';
const d = await cdp();
const ver = await d.ev('(function(){ const s = String(window.pet.voice.constructor); return "loaded"; })()');
console.log('页面:', ver.v);
await d.ev(`localStorage.setItem('pet-voice-engine', 'self'); localStorage.setItem('pet-asr-config', JSON.stringify({ provider: 'volc', appId: '7889599946', accessToken: '8DkN3mLYq0bMx51bWcMSPD2za3pBvmNz' }))`);
await d.startVoice();
await new Promise(r => setTimeout(r, 2500));
for (let round = 1; round <= 3; round++) {
  execSync('afplay /tmp/loud-test.wav');
  await new Promise(r => setTimeout(r, 13000));
  const n = d.logs.filter(l => /self-pipe/.test(l)).length;
  console.log('第' + round + '轮: ' + (n > 0 ? '✓' : '✗') + ' 累计=' + n);
}
await d.stopVoice();
d.close(); process.exit(0);
