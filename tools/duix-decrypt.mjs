// duix-decrypt.mjs — 解密DUIX模型文件（AES-128-CBC，密钥来自开源aes/aesmain.c）
// 用法: node duix-decrypt.mjs <加密文件> <输出文件>
// 文件结构: "gjdigits"(8B) + 3×8B size + AES-CBC密文
import { createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const KEY = Buffer.from('yymrjzbwyrbjszrk', 'utf8'); // 16字节
const IV = Buffer.from('yymrjzbwyrbjszrk', 'utf8');  // 16字节

const [,, inFn, outFn] = process.argv;
if (!inFn || !outFn) { console.error('用法: node duix-decrypt.mjs <in> <out>'); process.exit(1); }

const raw = readFileSync(inFn);
console.log('输入:', inFn, raw.length, 'bytes, 头部:', raw.slice(0, 8).toString('latin1'));

if (raw.slice(0, 8).toString('latin1') !== 'gjdigits') {
  console.log('⚠️ 无 gjdigits 头——可能已是明文，直接复制');
  writeFileSync(outFn, raw);
  process.exit(0);
}

// 头部: 8B magic + 3×8B size（其中一个是原始大小）
const sizeA = Number(raw.readBigUInt64LE(8));
const sizeB = Number(raw.readBigUInt64LE(16));
const sizeC = Number(raw.readBigUInt64LE(24));
console.log('size字段:', sizeA, sizeB, sizeC);

const body = raw.subarray(32); // 24? 32? — 加密端写了8+8+8+8=32字节头
// 尝试偏移24（8 magic + 2×8 size）与32（8 magic + 3×8 size）
for (const off of [24, 32]) {
  const data = raw.subarray(off);
  try {
    const d = createDecipheriv('aes-128-cbc', KEY, IV);
    d.setAutoPadding(false); // 看源码是流式16字节块加密，无PKCS填充
    const out = Buffer.concat([d.update(data), d.final()]);
    // 打印前64字节判断格式
    const head = out.subarray(0, 64);
    const isText = head.every(b => b === 0x0a || b === 0x09 || (b >= 0x20 && b < 0x7f));
    console.log(`偏移${off}: 解密${out.length}B 前缀${isText ? '(文本!)' : '(二进制)'}:`, head.subarray(0, 48).toString(isText ? 'utf8' : 'hex').replace(/\n/g, '\\n'));
  } catch (e) { console.log(`偏移${off} 失败:`, e.message); }
}

// 默认用偏移32（与加密端写入一致：magic+3×size）
const d = createDecipheriv('aes-128-cbc', KEY, IV);
d.setAutoPadding(false);
const out = Buffer.concat([d.update(raw.subarray(32)), d.final()]);
// 去尾部PKCS式填充（若有）：块对齐加密时尾部可能补0或重复字节
writeFileSync(outFn, out);
console.log('已写出:', outFn, out.length, 'bytes');
