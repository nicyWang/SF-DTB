// ============================================================
// pet/tasks.js — 屏幕操控任务（CUA 行动回路：截屏→AX树定位→执行→验证）
// 从 pet.js 拆出（2026-08-22 架构收敛第4步）；pet=PetController 实例
// ============================================================


/**
 * 任务验证器：任务分类 → 专属验证策略（判断"真完成"的统一入口）。
 * 每类任务有独立的证据链，不依赖单一按钮文字：
 *  - 播放/暂停：按钮语义双向校验 + 执行前记录状态，要求状态翻转
 *  - 打开应用：目标进程存在（系统级）
 *  - 打开面板/页面：AX 树新增元素对比（执行前快照 vs 执行后）
 *  - 输入文字：目标输入框 value 非空
 *  - 文件操作：文件系统直接查
 *  - 其他：AX 树变化 + vision 证据
 */
export async function verifyTask(pet, task, axTreeBefore) {
  const taskS = String(task);
  // 1) 播放/暂停类：终极证据=麦克风听扬声器能量（2秒采样，RMS>0.02=有声）
  //    （按钮文本不可靠：酷狗切换后 AX desc 不刷新）
  if (/播放|放.*(歌|音乐|电台)/.test(taskS) && !/暂停|停/.test(taskS)) {
    try {
      const r = await window.windowAPI.invokeTool('mic-energy', {});
      const rms = Number(r?.result) || 0;
      if (rms > 0.02) return { ok: true, evidence: '扬声器有声（RMS=' + rms.toFixed(3) + '）' };
      return { ok: false, evidence: '扬声器静默（RMS=' + rms.toFixed(3) + '）' };
    } catch { /* 无此工具则落按钮检测 */ }
  }
  if (/(暂停|停止).*(音乐|歌|播放)/.test(taskS)) {
    try {
      const r = await window.windowAPI.invokeTool('mic-energy', {});
      const rms = Number(r?.result) || 0;
      if (rms < 0.01) return { ok: true, evidence: '已静音（RMS=' + rms.toFixed(3) + '）' };
    } catch { /* ignore */ }
  }
  // 1b) 按钮状态（次选，酷狗等不刷新的会漏——由上面能量法兜底）
  if (/播放|放.*(歌|音乐|电台)/.test(taskS)) {
    try {
      const r = await window.windowAPI.invokeTool('ui-list', {});
      const t = String(r?.result || '');
      const btn = t.split('\n').find((l) => /\[(\d+)\].*(暂停|播放)/.test(l) && !/列表|随机|电台|模式|歌单/.test(l));
      if (btn) {
        const nowPaused = btn.includes('暂停');
        const wasPaused = axTreeBefore ? (axTreeBefore.split('\n').find((l) => /暂停/.test(l) && !/列表|随机|电台|模式|歌单/.test(l)) ? true : false) : false;
        if (nowPaused !== wasPaused) return { ok: true, evidence: nowPaused ? '已暂停' : '已开始播放' };
        return { ok: false, evidence: nowPaused ? '仍处于暂停（点击未生效）' : '本来就在播放' };
      }
    } catch { /* ignore */ }
  }
  // 2) 打开应用类：查进程
  if (/打开|启动/.test(taskS) && /微信|酷狗|网易云|备忘录|浏览器|Safari|Chrome|音乐|计算器|日历|访达/.test(taskS)) {
    const APP_PROC = { '微信': 'WeChat', '酷狗': 'KugouMusic', '网易云': 'NeteaseMusic', '备忘录': 'Notes', '浏览器': 'Safari', 'Safari': 'Safari', 'Chrome': 'Google Chrome', '计算器': 'Calculator', '日历': 'Calendar', '访达': 'Finder' };
    const key = Object.keys(APP_PROC).find((k) => taskS.includes(k));
    if (key) {
      try {
        const r = await window.windowAPI.invokeTool('shell', { cmd: 'pgrep -x ' + APP_PROC[key] });
        if (String(r?.result || '').trim()) return { ok: true, evidence: APP_PROC[key] + ' 进程已运行' };
        return { ok: false, evidence: '未检测到进程' };
      } catch { /* ignore */ }
    }
  }
  // 3) 通用：AX 树有变化（元素数/内容差异）
  try {
    const r = await window.windowAPI.invokeTool('ui-list', {});
    const after = String(r?.result || '');
    if (axTreeBefore && axTreeBefore !== after) {
      const aL = axTreeBefore.split('\n').filter(Boolean);
      const bL = after.split('\n').filter(Boolean);
      const added = bL.filter((l) => !aL.includes(l)).length;
      if (added > 0) return { ok: true, evidence: '界面新增 ' + added + ' 个元素（状态已变化）' };
    }
  } catch { /* ignore */ }
  return null; // 无法判定 → 由 vision evidence 兜底
}

export function isScreenAction(pet, text) {
  return /(点|点击|单击|双击|右键|关掉|关闭|按下|勾选|选择|拖|输入|填).{0,20}(它|那个|这个|按钮|弹窗|窗口|选项|框|图标|位置|搜索|输入)|帮我(点|关|拖|选|填|处理)|(点|关)一下(它|那个)|在.{0,12}(里|中|上面).{0,6}(输入|填|写)|^(播放|放).{0,12}(歌|音乐|电台|电台歌曲|歌单)|(播放|放一?首)/.test(text);
}

export function canCaptureScreen(pet, ) {
  return typeof window.screenAPI?.getScreenshot === 'function';
}

export async function screenActionLoop(pet, task) {
  pet._screenLooping = true;
  try {
    // ── 预处理：播放类任务（播放XX/打开XX电台）先启动目标应用 ──
    const playApp = task.match(/播放|听.*(歌|音乐|电台)/) && task.match(/酷狗|网易云|QQ音乐|QQ音乐|SpoBox|iTunes|音乐/);
    if (playApp) {
      const APP_MAP = { '酷狗': 'KugouMusic', '网易云': 'NeteaseMusic', 'QQ音乐': 'QQMusic', 'iTunes': 'Music' };
      const key = Object.keys(APP_MAP).find((k) => task.includes(k));
      if (key) {
        try { await window.windowAPI.invokeTool('open-app', { appName: APP_MAP[key] }); await new Promise((r) => setTimeout(r, 1800)); } catch { /* ignore */ }
      }
    }
    // ── 快通路：任务里提到明确元素名 → AX 名字直击（毫秒级，零截图）──
    // 提取候选名：引号内容 → "的XX按钮" → 动词短语 → 宽松兜底（去英文/助词后再提取）
    const quoted = task.match(/["''「」“”]([^"''「」“”]{1,12}?)["''「」“”]/);
    const de = task.match(/的([一-龥A-Za-z0-9]{2,8}?)按钮/);
    const verbObj = task.match(/(?:点击|点一下|点|按一下|按|关掉|关闭|按下)(?:那个)?([一-龥A-Za-z0-9]{2,8}?)(?:按钮|选项|图标|菜单|标签|键)/);
    let cand = (quoted?.[1] || de?.[1] || verbObj?.[1] || '').trim();
    if (!cand) {
      const cleaned = task.replace(/[A-Za-z]+|的|一下|那个|帮我/g, '');
      const loose = cleaned.match(/(?:点击|点|按|关掉|关闭)([一-龥]{2,8})/);
      cand = (loose?.[1] || '').trim();
    }
    if (cand && cand.length >= 2) {
      try {
        pet.bubble.showHint?.(`⚡ 直接找「${cand}」…`, 1500);
        const r = await window.windowAPI.invokeTool('ui-click', { name: cand });
        const rs = String(r?.result || r || '');
        if (r?.ok === true && rs.includes('已') && !rs.includes('执行失败')) {
          return `搞定啦（直击）！${rs.slice(0, 50)}`;
        }
      } catch { /* AX 没找到 → 落视觉回路 */ }
    }
    return await pet._screenActionLoopInner(task);
  } finally { pet._screenLooping = false; }
}

export async function screenActionLoopInner(pet, task) {
  const MAX_STEPS = 8; // 多步任务（如"播放电台"需 开应用→找入口→点播放 多轮）4轮不够
  let axTreeBefore = null; // 执行前 AX 快照（供 _verifyTask 状态对比）
  let silentTries = 0; // 同一目标静默点击次数（2次无效自动降级真实点击——菜单栏等系统元素不响应AX）
  let lastTarget = '';
  pet.bubble.showHint?.('🎯 开始操作…', 2000);
  for (let step = 1; step <= MAX_STEPS; step++) {
    try {
      // 1) 感知（Codex 式双通道）：
      //    a. AX 控件树（首选）：读系统 Accessibility 的元素名+精确坐标——零猜测
      //    b. 截图（辅助）：树里找不到目标（自绘UI/游戏）时视觉兜底
      // 任务提到具体应用 → 每轮确保其在前台（置顶小球会抢焦点，需反复激活）
      const APP_MAP2 = { '酷狗': 'KugouMusic', '网易云': 'NeteaseMusic', 'QQ音乐': 'QQMusic', '微信': 'WeChat', '备忘录': 'Notes', '浏览器': 'Safari', 'Safari': 'Safari', 'Chrome': 'Google Chrome', '访达': 'Finder', 'Finder': 'Finder', 'iTunes': 'Music' };
      const appKey = Object.keys(APP_MAP2).find((k) => task.includes(k));
      if (appKey) {
        try { await window.windowAPI.invokeTool('open-app', { appName: APP_MAP2[appKey] }); await new Promise((r) => setTimeout(r, 600)); } catch { /* ignore */ }
      }
      let axTree = '';
      try {
        const r = await window.windowAPI.invokeTool('ui-list', {});
        if (r?.ok && r.result) axTree = String(r.result);
      } catch { /* ignore */ }
      if (step === 1) axTreeBefore = axTree; // 记录初始状态
      const b64 = pet._canCaptureScreen() ? await window.screenAPI.getScreenshot() : null;
      if (!b64 && !axTree) return '截屏失败，没法操作屏幕';
      const img = b64 || null;
      if (!img) return '无法截屏';
      const treeHint = axTree
        ? `\n【可交互元素表：索引 角色 名称 状态 @坐标】\n${axTree.split('\n').slice(0, 35).join('\n')}`
        : '';
      const visionP = pet.llm.vision(img,
        `任务："${task}"。当前屏幕截图（第${step}轮，此前已执行过${step - 1}次点击）。${treeHint}
判定规则：
- done=true：任务意图已达成（目标面板弹出/状态变化/文字可见）。例："点时间"→面板弹出即完成；"播放歌曲"→正在播放/播放面板出现即完成。
- 定位规则：元素表里有的目标，直接用表里的绝对坐标（填入x_abs/y_abs），准确无误；表里没有才从截图估归一化坐标。
done 判定必须给证据（防误报）：done=true 时 evidence 必须写明看到了什么（如"播放条显示歌名《xx》且按钮变暂停"/"目标面板已展开且内容可见"）。仅"页面打开了/点过了"不算完成——任务的核心结果必须已发生。
严格JSON：{"done":bool, "evidence":"done时的可见证据，没有则空", "element_index":想点的元素索引号(来自元素表[N]，没有合适则-1), "target":{"name":"元素名","x":0-1000归一化,"y":0-1000,"x_abs":表里的绝对x或-1,"y_abs":表里的绝对y或-1,"action":"click|dblclick|rclick|type|none"}, "type_text":"", "status":"20字内画面状态"}
（优先用 element_index 点元素——索引由执行器换算真实坐标零误差；元素表没有目标才用x/y估坐标）`,
        'image/png');
      const analysis = await Promise.race([visionP, new Promise((rj) => setTimeout(() => rj(new Error('vision超时45s')), 45000))]).catch((e) => { throw e; });
      const m = String(analysis || '').match(/\{[\s\S]*\}/);
      if (!m) return `第${step}轮看不懂屏幕，放弃了。任务：${task}`;
      const j = JSON.parse(m[0]);
      // 2.5) 系统级验证器：done 声称完成 → 用该任务类型的专属证据链复核
      if (j.done) {
        const ver = await pet._verifyTask(task, axTreeBefore);
        if (ver && ver.ok === false) {
          console.log('[行动回路] 验证器否决:', ver.evidence, '→ 继续执行');
          j.done = false;
          j.target = j.target || {};
          if (!j.target.action || j.target.action === 'none') j.target.action = 'click';
        } else if (ver && ver.ok === true) {
          j.evidence = ver.evidence; // 系统证据覆盖 vision 证据（更硬）
        }
      }
      // 2) 完成 → 证据校验（防"点开了≠完成了"误报）：无证据的 done 不信，继续干活
      if (j.done) {
        const ev = String(j.evidence || '').trim();
        if (!ev || ev.length < 4) {
          console.log('[行动回路] done无证据，忽略继续执行');
        } else {
          return step === 1 ? `搞定啦！${ev}` : `搞定啦（${step}轮）！${ev}`;
        }
      }
      console.log(`[行动回路] 第${step}轮 done=false target=(${j.target?.x},${j.target?.y}) status=${j.status}`);
      // 3) 无目标无动作 → 报告卡住
      if (!j.target || j.target.action === 'none') {
        if (step >= MAX_STEPS) return `试了${step}轮还是不知道怎么操作：${j.status}`;
        continue; // 再看一眼（屏幕可能在动）
      }
      // 3.5) 播放类任务专项验证（酷狗实测语义）：
      // 按钮显示"暂停"=当前处于暂停状态（没在放）！必须再点它才会开始播放。
      // 点击后再查：按钮变"播放/继续"才算真正在放歌。
      if (j.done && /播放|放.*歌|电台|音乐/.test(task) && axTree) {
        const btnLine = axTree.split('\n').find((l) => /暂停|播放/.test(l) && !/列表|随机|电台|歌单|模式/.test(l));
        const paused = /暂停/.test(btnLine || '');
        if (paused) {
          console.log('[行动回路] 播放任务但按钮=暂停（未在放）→ 补一次点击启动播放');
          j.done = false;
          j.target = j.target || { name: '播放按钮' };
          j.target.action = 'click';
          // 优先点暂停按钮本身（点它=恢复播放）
          const mBtn = /\[(\d+)\].*暂停/.exec(btnLine || '');
          if (mBtn) j.element_index = Number(mBtn[1]);
        }
      }

      // 4) 行动：索引优先（模型给 or 本地关键词兜底匹配）> 绝对坐标 > 归一化估算
      let elIdx = Number(j.element_index);
      // 模型失能兜底：element_index=-1 → 用任务关键词直查元素表（本地匹配零智力依赖）
      if (!(Number.isInteger(elIdx) && elIdx >= 0)) {
        const kwMap = [
          [/播放|放歌|听歌|放音乐/, /\[(\d+)\]\s*\w+\s*\/?暂停(?!列表|模式)/],
          [/暂停|停止/, /\[(\d+)\]\s*\w+\s*\/?播放(?!列表|模式|电台|歌单)/],
          [/搜索|查找/, /\[(\d+)\]\s*AX(SearchField|TextField)/],
        ];
        for (const [kw, re] of kwMap) {
          if (kw.test(task) && axTree) {
            const m2 = re.exec(axTree);
            if (m2) { elIdx = Number(m2[1]); console.log('[行动回路] 模型未给索引，本地匹配元素[' + elIdx + ']'); break; }
          }
        }
      }
      if (Number.isInteger(elIdx) && elIdx >= 0 && (j.target?.action === 'click' || !j.target?.action)) {
        try {
          const r = await window.windowAPI.invokeTool('ui-click', { index: elIdx, app: appKey ? APP_MAP2[appKey] : undefined });
          if (r?.ok === true) {
            pet.bubble.showHint?.(`🖱 点元素[${elIdx}] · 第${step}轮`, 2000);
            await new Promise((r2) => setTimeout(r2, 1000)); // 等界面响应，下一轮刷新快照验证
            continue;
          }
        } catch (e) { console.warn('[行动回路] 索引点击失败，落坐标:', e?.message); }
      }
      const absX = Number(j.target.x_abs), absY = Number(j.target.y_abs);
      let px = (Number.isFinite(absX) && absX > 10) ? Math.round(absX) : Math.round((Number(j.target.x) / 1000) * screen.width);
      let py = (Number.isFinite(absY) && absY > 10) ? Math.round(absY) : Math.round((Number(j.target.y) / 1000) * screen.height);
      // 坐标防呆：落到屏幕角落(0,0 附近)=无效目标 → 本轮跳过不点（防误点）
      if (px < 30 && py < 30) {
        console.log('[行动回路] 目标坐标无效 (' + px + ',' + py + ')，跳过本轮点击');
        continue;
      }
      const act = j.target.action;
      const sameTarget = lastTarget === j.target.name;
      silentTries = sameTarget ? silentTries + 1 : 0;
      lastTarget = j.target.name;
      const useSilent = silentTries < 2; // 前两次静默
      let actDesc = act === 'click' ? '点击' : act === 'dblclick' ? '双击' : act === 'rclick' ? '右键' : '输入';
      if (act === 'click' && !useSilent) actDesc += '(真实)';
      pet.bubble.showHint?.(`🖱 ${actDesc} ${j.target.name} (${px},${py}) · 第${step}轮`, 2000);
      if (act === 'click') await window.windowAPI.invokeTool('click-at', { x: px, y: py, silent: useSilent });
      else if (act === 'dblclick') await window.windowAPI.invokeTool('mouse-dblclick', { x: px, y: py });
      else if (act === 'rclick') await window.windowAPI.invokeTool('mouse-rightclick', { x: px, y: py });
      else if (act === 'type') {
        await window.windowAPI.invokeTool('click-at', { x: px, y: py, silent: true });
        await new Promise(r => setTimeout(r, 400));
        await window.windowAPI.invokeTool('type-text', { text: String(j.type_text || '') });
      }
      await new Promise(r => setTimeout(r, 900)); // 等界面响应，下一轮截屏验证
    } catch (e) {
      console.warn('[PetController] 行动回路异常:', e?.message);
      if (step >= MAX_STEPS) return `操作出错了：${e?.message || '未知'}`;
    }
  }
  return `试了${MAX_STEPS}轮没完成，我先停了（怕乱点）。你可以再说得更具体些～`;
}

export function isScreenRequest(pet, text) {
  return /(屏幕|画面|截屏|截图|窗口|弹窗|按钮|那个东西|这个位置|坐标|点一下|点击|关掉它|右上|左下|帮我处理)/.test(text);
}

/**
 * 实时屏幕分析：截屏 → vision 识别（内容+目标元素坐标）
 * 返回注入对话的上下文（含屏幕尺寸与目标坐标，供 AppleScript 工具执行点击）
 */
export async function analyzeScreenFor(pet, query) {
  try {
    if (!pet._canCaptureScreen()) return '';
    pet.bubble.showHint?.('📸 正在看你的屏幕…', 2000);
    const b64 = await window.screenAPI.getScreenshot();
    if (!b64) return '';
    const analysis = await pet.llm.vision(b64,
      `主人说："${query}"。请分析这张屏幕截图：1)屏幕上有什么（应用/窗口/主要内容，30字内）2)与主人请求相关的目标元素在图中的位置（归一化坐标0-1000，左上原点）3)操作类请求给出建议动作。严格JSON：{"scene":"描述","target":{"name":"元素名","x":123,"y":456,"action":"click|close|none"}}`, 'image/png');
    const m = String(analysis || '').match(/\{[\s\S]*\}/);
    if (!m) return `【屏幕实况】刚截了你的屏幕，画面内容：${String(analysis).slice(0, 80)}`;
    const j = JSON.parse(m[0]);
    const w = screen.width, h = screen.height;
    const px = j.target ? Math.round((j.target.x / 1000) * w) : 0;
    const py = j.target ? Math.round((j.target.y / 1000) * h) : 0;
    pet._screenTarget = j.target ? { ...j.target, px, py, screenW: w, screenH: h } : null;
    let ctx = `【屏幕实况】你能实时看到主人屏幕（刚截图分析过）。画面：${j.scene}`;
    if (pet._screenTarget) {
      ctx += `。与请求相关的目标：${j.target.name}，屏幕绝对坐标约 (${px}, ${py})（屏幕 ${w}x${h}）`;
      if (j.target.action === 'click') ctx += '。可用 run_applescript 工具在该坐标执行点击。';
    }
    ctx += ' 回答时自然描述你看到的内容，证明你能看到屏幕。';
    return ctx;
  } catch (e) {
    console.warn('[PetController] 屏幕分析失败:', e?.message);
    return '';
  }
}

