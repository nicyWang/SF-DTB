// ============================================================
// pet/conversation.js — 对话流程（消息组装/语音执行/播报/错误处理）
// 从 pet.js 拆出（2026-08-22 架构收敛第4步）；pet=PetController 实例
// ============================================================


export async function _buildMessages(pet, queryText) {
  const sysLines = [pet.personality.getSystemPrompt()];

  // 知识库检索：与当前话题最相关的"对主人的了解"注入（越聊越懂主人）
  if (pet.knowledge) {
    try {
      const kbBlock = await pet.knowledge.buildPromptBlock(queryText || '');
      if (kbBlock) sysLines.push('', kbBlock);
    } catch (e) { /* 知识库故障不阻塞对话 */ }
  }

  // 屏幕感知注入：主人当前在干什么（问"你能看到我屏幕吗"时有真话可说）
  const snap = pet.perception?.getLatestSnapshot?.();
  if (snap && !snap.stale) {
    const label = { work: '工作', fun: '娱乐', slack: '摸鱼', rest: '休息', late_night: '深夜用电脑' }[snap.scene] || snap.scene;
    sysLines.push('', `【屏幕感知】你能实时看到主人的屏幕（周期截屏分析）。当前画面：主人正在${label}——${snap.detail}。主人问到屏幕相关话题时，基于此回答，不要说"看不到"。`);
  }

  const ctx = await pet.memory.getContext(20);
  // 记忆块：长期+情感（短期走对话流，避免重复）
  const memoryItems = ctx.filter((it) => it.type !== 'short');
  if (memoryItems.length) {
    sysLines.push('', '【记忆】');
    const label = { long: '长期', emotional: '情感' };
    for (const it of memoryItems) {
      const content = it.content.length > 80 ? it.content.slice(0, 80) + '…' : it.content;
      sysLines.push(`- (${label[it.type] || it.type}) ${content}`);
    }
  }
  const messages = [{ role: 'system', content: sysLines.join('\n') }];

  // 最近对话：短期记忆还原多轮（最新在前 → 反转为时间正序）
  const shorts = ctx.filter((it) => it.type === 'short').slice(0, 10);
  const dialogue = shorts
    .slice()
    .reverse()
    .map((it) => {
      if (it.content.startsWith('主人说：')) return { role: 'user', content: it.content.slice(4) };
      if (it.content.startsWith('我回复：')) return { role: 'assistant', content: it.content.slice(4) };
      return { role: 'user', content: it.content };
    })
    .slice(-8); // 最多8条近对话
  messages.push(...dialogue);
  return messages;
}
export async function _llmNeedTool(pet, text) {
  try {
    const r = await Promise.race([
      pet.llm.chat([
        { role: 'system', content: '判断这句话是否是让助手在本机执行操作的指令（需调用工具）。判定规则（重要）：出现"点击/点一下/单击/按下/关掉/勾选/双击/右键"等操作动词（无论后面跟什么名词，如"下一步""确认""登录""它"）→必须yes；①"打开/启动/开一下/我要用 + 应用"→yes ②"提醒/闹钟/叫我/X分钟后"→yes ③"看看/列出/整理 + 桌面/文件夹/文件"→yes ④"截屏/截图"→yes ⑤涉及屏幕内容："屏幕上/画面上/那个窗口/弹窗/按钮/关掉/点一下/右上角/左下角/帮我处理"→yes ⑤b "输入/打字/填上/写上 + 内容"→yes ⑤c "发微信/给XX发消息/发条消息/发给他/发给她"→yes ⑤b "输入/打字/填上/写上 + 内容"→yes（键盘输入工具） ⑥问"能看到我屏幕吗"→yes ⑦纯聊天/讲笑话/问天气→no。只回答yes或no。' },
        { role: 'user', content: text },
      ]),
      new Promise(res => setTimeout(() => res('no'), 10000)),
    ]);
    let ans = String(r || '').toLowerCase().includes('yes');
    // 双保险：LLM 漏判时的强化正则（口语化变体兜底）
    if (!ans) {
      const RE = /(打开|启动|开一下|开个|我要用|我想用|帮我开).{0,12}(微信|safari|访达|finder|备忘录|音乐|日历|计算器|地图|邮件|照片|终端|浏览器|应用|app)|((看看|列出|整理|查查?|有什么).{0,8}(桌面|下载|文档|文件夹|目录|文件))|(提醒|闹钟|叫我|截屏|截图)/i;
      ans = RE.test(text);
    if (!ans) {
      const SCREEN_RE = /(屏幕|画面|截图|截屏|窗口|弹窗|按钮).{0,20}(哪个|哪里|什么|位置|看到|帮我|处理|关掉|点击|点一下)|帮我(关闭|点击|处理)|能看到.{0,8}(屏幕|我)/i;
      ans = SCREEN_RE.test(text);
    if (!ans) ans = /(发|发送|回).{0,6}(微信|消息)|(给|帮).{1,12}(发|送)(个|条|下)?.{0,4}(微信|消息|信息)/i.test(text);
    if (!ans) ans = /(按|敲|点).{0,15}(command|cmd|⌘|ctrl|control|快捷键|回车|esc|删除键|tab)|(复制|粘贴|全选|截图|撤销|保存)一下?$|(复制|粘贴|全选|撤销)/.test(text);
    if (!ans) ans = /^(点击|点一下|单击|双击|右键点击|按下|按一下|按|勾选|关掉|关闭|打开)(.{0,14})$/m.test(text.trim()); // 操作动词开头=指令
    }
    }
    console.log('[PetController] 工具意图判断:', ans ? 'TOOL' : 'chat', '←', text.slice(0, 20));
    return ans;
  } catch { return false; }
}
export async function _processVoiceText(pet, text) {
  if (!text || !pet._voiceActive) return;
  const t0 = Date.now();
  pet.voice.stopListen?.();
  pet._emitVoiceState('thinking');
  pet.bubble.showHint?.(`你说：${text}`, 3000);

  // 先应答（操作类指令即时给"好嘞"——感知延迟降到零，GLM 后台干活）
  const ACTION_HINT = /^(打开|关闭|关掉|点击|点|启动|帮我|设置?个?|定个?|发|按|输入)/.test(text.trim());
  if (ACTION_HINT) {
    pet.bubble.showHint?.('好嘞，马上！', 1200);
  }

  let reply = '';
  try {
    reply = await pet.chat(text); // GLM 原生工具链（chat 内含工具铁律+两阶段强制）
  } catch (err) {
    console.error('[PetController] 语音 chat 失败:', err);
  }
  console.log(`[self-pipe] 全链路耗时 ${Date.now() - t0}ms`);
  if (!pet._voiceActive) return; // 会话已被用户终止

  // 病理文本清洗：错误文案（含HTTP状态码等）不该原样念给主人听，也不该把半截 JSON 念出来
  const isErrText = /^(（.*(失败|错误|受限|不可用|稍后)|.*HTTP \d+.*）?$)/.test(String(reply || '').trim());
  const clean = String(reply || '')
    .replace(/\{[^{}]*"(index|finish_reason|choices|delta)"[^{}]*\}/g, '')  // 流中断残留的 SSE JSON 片段
    .replace(/data:.*$/gm, '')
    .trim();
  if (isErrText || !clean) {
    // 冷却 60s：服务过载/限流时连续失败不该连环播报"再说一次"（用户被念到烦）
    const now = Date.now();
    if (pet._voiceActive && now - (pet._lastErrHintAt || 0) > 60000) {
      pet._lastErrHintAt = now;
      pet.bubble.showHint?.('哎呀，我脑子刚才卡了一下，再说一次？', 2500);
      await pet._speakReply('哎呀，我刚才没反应过来，主人再说一次好不好');
    } else if (pet._voiceActive) {
      pet.bubble.showHint?.('（网络开小差了，稍等下再试～）', 2000);
    }
    if (!pet._voiceActive) return;
  } else {
    if (reply) await pet._speakReply(clean);
  }
  if (!pet._voiceActive) return;

  // 播报结束 → 继续听（循环对话）
  if (pet.voice.getVoiceLoopActive?.()) {
    pet._emitVoiceState('listening');
  } else {
    pet._startVoiceListen();
  }
}
/**
 * TTS 播报 + 口型续命（Edge → 智谱 → 系统三级降级；打电话式可打断）
 * 播报期间 VAD 武装打断模式：用户插嘴 → 立即停所有 TTS → 插话录音断句转写（走 _processVoiceText）
 * @returns {Promise<'full'|'interrupted'|'none'>}
 */
export async function speakReply(pet, reply) {
  pet._speakingVoice = true;
  pet._setFrozen(true); // 播报期间静止（气泡可读）
  pet._emitVoiceState('speaking');
  let lipTimer = null;
  const startLip = () => {
    lipTimer = setInterval(() => pet.live2d.lipSpeak?.(1400), 1200);
  };
  // 打断回调：用户插嘴瞬间 → 闭嘴（Edge afplay kill + 智谱/系统 TTS cancel）
  if (pet.voice.getVoiceLoopActive?.()) {
    pet.voice.armInterrupt?.(() => {
      pet.voice.stopAllTTS();
      pet.bubble.showHint?.('（好，你先说～）', 1800);
    });
  }
  let outcome = 'none';
  try {
    // 0) 豆包 TTS（火山语音合成大模型·灿灿甜美女声——与极速模式同源豆包嗓，体验统一）
    if (outcome === 'none' && typeof pet.voice.speakDoubao === 'function') {
      try {
        const r = await pet.voice.speakDoubao(reply, { onStart: startLip, emotion: pet.state.emotion });
        if (r) outcome = 'full';
      } catch (e) { console.warn('[PetController] 豆包TTS失败，降级:', e?.message); }
    }
    // 1) Edge TTS（微软神经网络，甜美真人音色，免费）
    if (outcome === 'none' && typeof pet.voice.speakEdge === 'function') {
      const r = await pet.voice.speakEdge(reply, { onStart: startLip });
      if (r === 'full' || r === 'interrupted') outcome = r;
    }
    // 2) 智谱 GLM-TTS（配置了 key 时）
    if (outcome === 'none' && typeof pet.voice.speakCloud === 'function') {
      const r = await pet.voice.speakCloud(reply, { onStart: startLip });
      if (r) outcome = 'full';
    }
    // 3) 系统 speechSynthesis 兜底
    if (outcome === 'none') {
      const r = await pet.voice.speak(reply, { onStart: startLip });
      if (r) outcome = 'full';
    }
    // 注：任何一级播报中被插嘴 → stopAllTTS 已停当前级 → 此处不降级（用户在说话），
    // outcome 保持该级返回值（Edge 级可识别 interrupted；其余级被停即返回 false→none，
    // 但不打紧——插话的转写会开启新一轮 _processVoiceText）
  } finally {
    pet.voice.disarmInterrupt?.();
    if (lipTimer) clearInterval(lipTimer);
    pet._speakingVoice = false;
    pet._setFrozen(false); // 播报结束解冻
  }
  return outcome;
}

export async function onVoiceError(pet, msg) {
  // SpeechRecognition 报 network/service-not-allowed（Electron 缺 Google key）
  // → getASRMode() 已自动切 recorder → 这里无缝转入 VAD 持续听，不打断用户
  if (pet._voiceActive && pet.voice?.getASRMode?.() === 'recorder'
      && typeof pet.voice.startVoiceLoop === 'function') {
    pet.bubble.showHint?.('实时识别不可用，已切换到录音转写模式，请继续说～', 3500);
    const ok = await pet.voice.startVoiceLoop({
      onPartial: () => {},
      onFinal: (text) => pet._processVoiceText(text),
      onError: (m) => pet._onVoiceError(m),
      onState: (s) => pet._emitVoiceState(s === 'transcribing' ? 'thinking' : 'listening'),
    });
    if (ok) return;
    // VAD 也失败（无麦/权限）→ 走下面的常规报错
  }
  pet._voiceActive = false;
  pet.voice?.stopListen?.();
  pet._stopVoiceLoop?.();
  pet._emitVoiceState('idle');
  pet.bubble.showHint?.(`语音不可用：${msg || '未知错误'}。双击我用文字聊天吧～`, 4500);
}

/**
 * 统一语音执行器（2026-08-22 架构收敛）：
 * 用户最终文本 → 一路经 pet.chat（工具/记忆/性格/知识库）→ doubao.say() 代播。
 * 无标签协议、无两段式意图判断——路径唯一。
 * 她思考期间 suppress 豆包bot音频（防双声），说完恢复。
 */
export function execVoiceUnified(pet, text) {
  if (!text || pet._toolRouting) return;
  pet._toolRouting = true;
  (async () => {
    let replied = false;
    try {
      pet.doubao?.suppressAudio?.();  // 思考期间丢弃豆包bot可能的多嘴
      pet._emitVoiceState('thinking');
      pet.bubble.showHint?.(`你说：${text}`, 2500);

      let reply;
      // 屏幕操作类 → CUA 行动回路；其余 → chat 工具链
      if (pet._isScreenAction?.(text) && pet._canCaptureScreen()) {
        reply = await pet._screenActionLoop(text);
      } else {
        reply = await pet.chat(text);
      }

      // 播报：豆包音色代播（WS在）；降级本地TTS链（WS已断）
      const clean = String(reply || '').trim();
      if (clean && pet._voiceActive) {
        pet.bubble.showText(clean.slice(0, 150), Math.max(4000, clean.length * 120));
        pet._applyReplyEmotion(text, clean); // 表情跟回复情绪
        if (pet.doubao?.active) {
          pet.doubao.say?.(clean.slice(0, 200));
          pet._emitVoiceState('speaking');
          replied = true;
        } else {
          await pet._speakReply(clean);
          replied = true;
        }
      }
    } catch (e) {
      console.warn('[PetController] 统一语音执行失败:', e?.message);
      pet.bubble.showHint?.('刚才没处理好，再说一次？', 2200);
    } finally {
      pet._toolRouting = false;
      pet.doubao?.resumeAudio?.();
      if (pet._voiceActive && pet.doubao?.active) {
        pet._emitVoiceState(replied ? 'listening' : 'listening');
      }
    }
  })();
}

