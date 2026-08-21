// ============================================================
// charprompt.js — 角色工坊提示词构建器（提示词工程系统核心）
// 严格按 docs/character-generation-skill.md 实现：
//   一、三风格模板  二、槽位词库  三、照片转绘vision prompt
//   四、质量保障词（固定内嵌于模板）  五、程序化表情滤镜映射
// 纯函数模块，无 DOM / 存储依赖，可在 node 与浏览器环境运行。
// ============================================================

// ---------- 一、风格模板（三选一；质量保障词已固定内嵌） ----------
const STYLE_TEMPLATES = {
  realistic:
    '写实人像摄影风立绘：{age}{gender}，{face}，{hair}，{clothing}，{temperament}，'
    + '时尚杂志大片质感，高级打光突出面部立体感，人物居中完整呈现全身，'
    + '站姿自然，构图人物占画面80%以上，'
    + '浅灰色纯色摄影棚背景（背景均匀无渐变无阴影），'
    + '高质量细节，8K画质，专业人像摄影',
  anime:
    '高质量动漫立绘：{age}{gender}，{face}，{hair}，{clothing}，{temperament}，'
    + '精致日系动画风格，细腻上色，干净利落的线条，'
    + '人物居中全身立绘构图，站姿自然有亲和力，'
    + '浅灰色纯色背景（均匀无渐变），'
    + '高清细节，专业插画水准',
  game:
    '游戏角色立绘CG：{age}{gender}，{face}，{hair}，{clothing}，{temperament}，'
    + '精致的游戏立绘质感，光影层次丰富，细节华丽，'
    + '人物居中全身构图，站姿自然，'
    + '浅灰色纯色背景（均匀无渐变），'
    + '高质量渲染，次世代游戏CG水准',
};

const STYLE_NAMES = { realistic: '写实摄影风', anime: '精致动漫风', game: '游戏CG风' };

// ---------- 二、槽位词库 ----------
const GENDERS = { male: '男', female: '女' };

const AGE_BANDS = {
  '18-22': '18-22岁青春感',
  '23-27': '23-27岁',
  '28-35': '28-35岁成熟感',
  '36-45': '36-45岁知性优雅',
};

// 面部气质（可组合2-3个）
const FACES = {
  male: ['帅气硬朗', '剑眉星目', '温润儒雅', '深邃眼眸', '高挺鼻梁', '轮廓分明', '阳光开朗', '冷峻贵气'],
  female: ['精致面容', '明眸善睐', '温柔甜美', '气质出众', '五官立体', '笑容治愈', '御姐气场', '清纯可人'],
};

// 发型发色
const HAIRS = {
  male: ['黑色短发干净利落', '微卷短发时尚感', '侧分长发艺术家气质', '寸头硬朗'],
  female: ['长直发黑亮', '大波浪卷发妩媚', '齐肩短发干练', '高马尾活泼', '双马尾可爱'],
};

// 服装（按气质分组，组内二选一）
const CLOTHINGS = {
  business: ['修身西装+白衬衫', '商务休闲西装'],
  casual: ['卫衣+牛仔裤', 'T恤+休闲裤'],
  elegant: ['晚礼服', '修身连衣裙'],
  cute: ['JK制服', '洛丽塔裙装'],
  sport: ['运动套装', '瑜伽服'],
};
const CLOTHING_GROUP_NAMES = {
  business: '商务精英', casual: '阳光休闲', elegant: '优雅礼服', cute: '可爱系', sport: '运动系',
};

// 整体气质（决定"性感/魅力"的度）
const TEMPERAMENTS = {
  mature: '成熟魅力型：气质优雅自信，身姿挺拔，举手投足间散发魅力',
  sunny: '阳光活力型：笑容灿烂，元气满满，青春活力四射',
  gentle: '温柔治愈型：气质温柔，眼神柔和，让人如沐春风',
  queen: '高冷御姐型：气场强大，眼神自信，霸气侧漏',
  sweet: '甜美可爱型：俏皮灵动，甜美动人，少女感十足',
};
const TEMPERAMENT_NAMES = {
  mature: '成熟魅力型', sunny: '阳光活力型', gentle: '温柔治愈型', queen: '高冷御姐型', sweet: '甜美可爱型',
};

// ---------- 五、程序化表情滤镜映射（单图角色的情绪近似） ----------
// brightness/saturation → PIXI ColorMatrixFilter 参数（正=提亮/增饱和）
// scale → 整体缩放系数；sway → 轻微摇摆；offsetYRatio → 下垂位移（纹理高度比例）
// breathMul → 呼吸幅度倍率（sleepy 呼吸加深）
const EMOTION_FILTERS = {
  normal:  { brightness: 0,     saturation: 0,     scale: 1 },
  happy:   { brightness: 0.08,  saturation: 0.10,  scale: 1.02 },
  excited: { brightness: 0.12,  saturation: 0.18,  scale: 1.05, sway: true },
  sad:     { brightness: -0.08, saturation: -0.25, scale: 0.99, offsetYRatio: 0.012 },
  sleepy:  { brightness: -0.12, saturation: -0.15, scale: 1.0,  breathMul: 1.6 },
  bored:   { brightness: -0.04, saturation: -0.12, scale: 0.99 },
};

// 照片特征提取失败（如 LLM mock 模式）时的兜底特征 —— 保证全流程零成本可测
const DEFAULT_PHOTO_FEATURES = {
  gender: '男',
  age_band: '23-27',
  face: '帅气硬朗、深邃眼眸',
  hair: '黑色短发干净利落',
  clothing: '商务休闲西装',
  temperament: '成熟魅力型',
};

/** 判断值是否为用户角色 id（CharacterManager 生成的前缀） */
function isUserCharacterId(id) {
  return typeof id === 'string' && /^uc_[a-z0-9]+$/i.test(id) && id.length > 3;
}

class CharPromptBuilder {
  // ============================================================
  // 表单描述 → 生图 prompt
  // formData: {style, gender, ageBand, face[], hair, clothing, temperament, extra}
  // ============================================================
  buildFromForm(formData) {
    formData = formData || {};
    const style = STYLE_TEMPLATES[formData.style] ? formData.style : 'realistic';
    const genderKey = GENDERS[formData.gender] ? formData.gender : 'male';

    const age = AGE_BANDS[formData.ageBand] || AGE_BANDS['23-27'];
    const face = this._resolveFaces(formData.face, genderKey);
    const hair = this._resolveHair(formData.hair, genderKey);
    const clothing = this._resolveClothing(formData.clothing);
    const temperament = this._resolveTemperament(formData.temperament);

    let prompt = STYLE_TEMPLATES[style]
      .replace('{age}', age)
      .replace('{gender}', GENDERS[genderKey])
      .replace('{face}', face)
      .replace('{hair}', hair)
      .replace('{clothing}', clothing)
      .replace('{temperament}', temperament);

    const extra = String(formData.extra || '').trim();
    if (extra) prompt += '，' + extra;
    return prompt;
  }

  // ============================================================
  // 照片特征提取的 vision prompt（skill 文档第三节，原文）
  // ============================================================
  buildVisionPrompt() {
    return '分析这张人物照片，提取以下特征并以JSON返回（只回JSON不要其他文字）：'
      + '{'
      + '"gender": "男或女", '
      + '"age_band": "18-22|23-27|28-35|36-45 之一", '
      + '"face": "2-3个面部气质关键词，参考：帅气硬朗/精致面容/温柔甜美等", '
      + '"hair": "发型+发色描述", '
      + '"clothing": "照片中的服装描述", '
      + '"temperament": "整体气质关键词"'
      + '}';
  }

  // ============================================================
  // vision 提取的 JSON 特征 → 转绘 prompt（模板 + 追加参考照片句）
  // ============================================================
  buildFromPhotoFeatures(features, style) {
    features = features || {};
    const genderText = String(features.gender || '');
    const genderKey = /女/.test(genderText) || /^f/i.test(genderText) ? 'female' : 'male';
    const faceRaw = Array.isArray(features.face)
      ? features.face
      : String(features.face || '').split(/[,，、/|]/);
    const form = {
      style: STYLE_TEMPLATES[style] ? style : 'realistic',
      gender: genderKey,
      ageBand: AGE_BANDS[features.age_band] ? features.age_band : '23-27',
      face: faceRaw,
      hair: features.hair,
      clothing: features.clothing,
      temperament: features.temperament,
    };
    const prompt = this.buildFromForm(form);
    return prompt + '。参考照片人物的面部特征和气质，保持人物辨识度';
  }

  // ============================================================
  // 表情滤镜映射表（sprite.js 单图角色的程序化情绪近似）
  // ============================================================
  getEmotionFilters() {
    return JSON.parse(JSON.stringify(EMOTION_FILTERS));
  }

  // ============================================================
  // 表单可选项（settings.html 角色工坊动态渲染下拉/chips 的单一数据源）
  // ============================================================
  getFormOptions() {
    return {
      styles: Object.keys(STYLE_TEMPLATES).map((k) => ({ value: k, label: STYLE_NAMES[k] })),
      genders: [
        { value: 'male', label: '男' },
        { value: 'female', label: '女' },
      ],
      ageBands: Object.keys(AGE_BANDS).map((k) => ({ value: k, label: AGE_BANDS[k] })),
      faces: JSON.parse(JSON.stringify(FACES)),
      hairs: JSON.parse(JSON.stringify(HAIRS)),
      clothings: Object.keys(CLOTHINGS).map((k) => ({
        group: CLOTHING_GROUP_NAMES[k],
        options: CLOTHINGS[k].slice(),
      })),
      temperaments: Object.keys(TEMPERAMENTS).map((k) => ({ value: k, label: TEMPERAMENT_NAMES[k] })),
    };
  }

  // ============================================================
  // 从 LLM vision 回复中解析特征 JSON（容忍 ```json 包裹/前后缀文本）
  // @returns {object|null} 解析失败返回 null
  // ============================================================
  static parseVisionFeatures(reply) {
    if (typeof reply !== 'string') return null;
    const m = reply.match(/\{[\s\S]*\}/);
    if (!m) return null;
    let obj;
    try { obj = JSON.parse(m[0]); } catch { return null; }
    if (!obj || typeof obj !== 'object') return null;
    const hasAny = ['gender', 'age_band', 'face', 'hair', 'clothing', 'temperament']
      .some((k) => obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '');
    if (!hasAny) return null;
    return {
      gender: String(obj.gender || ''),
      age_band: String(obj.age_band || ''),
      face: Array.isArray(obj.face) ? obj.face.map((s) => String(s)) : String(obj.face || ''),
      hair: String(obj.hair || ''),
      clothing: String(obj.clothing || ''),
      temperament: String(obj.temperament || ''),
    };
  }

  // ---------- 内部：槽位解析（词库命中 → 原样透传自由文本 → 缺省兜底） ----------

  _resolveFaces(face, genderKey) {
    let arr = [];
    if (Array.isArray(face)) arr = face.map((s) => String(s).trim()).filter(Boolean);
    else if (typeof face === 'string' && face.trim()) arr = face.split(/[,，、/|]/).map((s) => s.trim()).filter(Boolean);
    if (!arr.length) arr = FACES[genderKey].slice(0, 2); // 缺省取该性别前两个
    return arr.slice(0, 3).join('、'); // skill：可组合2-3个
  }

  _resolveHair(hair, genderKey) {
    const v = typeof hair === 'string' ? hair.trim() : '';
    if (!v) return HAIRS[genderKey][0];
    return HAIRS[genderKey].includes(v) || HAIRS[genderKey === 'male' ? 'female' : 'male'].includes(v)
      ? v : v; // 词库短语或自由文本均透传
  }

  _resolveClothing(clothing) {
    const v = typeof clothing === 'string' ? clothing.trim() : '';
    if (!v) return CLOTHINGS.business[0];
    if (CLOTHINGS[v]) return CLOTHINGS[v][0];       // 传的是组键（business 等）
    return v;                                        // 词库短语或自由文本透传
  }

  _resolveTemperament(temperament) {
    const v = typeof temperament === 'string' ? temperament.trim() : '';
    if (!v) return TEMPERAMENTS.mature;
    if (TEMPERAMENTS[v]) return TEMPERAMENTS[v];     // 传的是键（mature 等）
    return v;                                        // 自由文本透传
  }
}

export default CharPromptBuilder;
export {
  CharPromptBuilder,
  STYLE_TEMPLATES, STYLE_NAMES,
  GENDERS, AGE_BANDS, FACES, HAIRS, CLOTHINGS, TEMPERAMENTS,
  EMOTION_FILTERS, DEFAULT_PHOTO_FEATURES,
  isUserCharacterId,
};
