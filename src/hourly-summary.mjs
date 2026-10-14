/**
 * 按小时滚动摘要（本机新增）。
 *
 * 目的：让 Agent「不再回头翻一小时前的原始聊天记录」，而是靠一份不断滚动的
 * 小时摘要继续对话 —— 既避免重复发言，也避免把几万字符的原文反复灌进上下文。
 *
 * 设计要点：
 *   1. **原文有时限**：`recentMessages` 只保留最近 `windowMs`（默认 1 小时）的原始记录。
 *      超出的按自然小时归并成摘要块，**原文丢弃**，只留摘要。
 *   2. **摘要必须短**：每个小时块最多 `maxBlockChars` 字符。
 *      否则"保留一小时"会让上下文从 6k 涨到 30k+ 字符，反而更贵。
 *   3. **确定性、零成本**：本模块不调用任何 LLM —— 摘要由启发式规则生成。
 *      每次心跳都可能跑，按小时滚动，所以必须廉价且可预测。
 *   4. **幂等**：同一批消息重复压缩不会产生重复块（按整点对齐后合并计数）。
 *   5. **不变量**：只做删除与归并，绝不改写在窗口内的原始消息 ——
 *      seq / messageId 是后续所有引用的基础，动它们会连带弄坏已读水位与引用解析。
 *
 * 纯函数：不做 IO、不读配置、不写日志。落盘与日志由调用方（bridge.js）负责。
 */

/** 默认参数。 */
export const DEFAULT_HOURLY = Object.freeze({
  enabled: true,
  windowMs: 60 * 60 * 1000,   // 原文保留：最近 1 小时
  maxBlocks: 24,              // 最多保留 24 个小时块（约一天）
  maxBlockChars: 320,         // 单个小时块的摘要上限
  keyPointsPerHour: 3,        // 每小时最多摘几句原话
  keyPointChars: 90           // 每句原话截断长度
});

const HOUR_MS = 60 * 60 * 1000;

/** 归一化配置，非法值回退默认。 */
export function resolveHourlyConfig(raw = {}) {
  const num = (v, fallback, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  return {
    enabled: raw.enabled !== false,
    windowMs: num(raw.windowMs, DEFAULT_HOURLY.windowMs, 5 * 60 * 1000, 12 * HOUR_MS),
    maxBlocks: num(raw.maxBlocks, DEFAULT_HOURLY.maxBlocks, 1, 168),
    maxBlockChars: num(raw.maxBlockChars, DEFAULT_HOURLY.maxBlockChars, 80, 2000),
    keyPointsPerHour: num(raw.keyPointsPerHour, DEFAULT_HOURLY.keyPointsPerHour, 0, 10),
    keyPointChars: num(raw.keyPointChars, DEFAULT_HOURLY.keyPointChars, 20, 300)
  };
}

/** 整点对齐的小时键，例如 2026-10-14T09:00。 */
export function hourKeyOf(ms) {
  const d = new Date(Math.floor(ms / HOUR_MS) * HOUR_MS);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:00`;
}

/** 消息里可读的正文（优先 text，回退 plain/tail）。 */
export function textOf(msg) {
  const raw = msg?.text ?? msg?.plain ?? msg?.tail ?? '';
  return String(raw).replace(/\s+/g, ' ').trim();
}

/** 直接 @ 我 / 拍一拍 / 纯表情占位 —— 这类对"发生了什么"几乎没有信息量。 */
function isNoise(text) {
  if (!text) return true;
  if (/^\[拍一拍\]/.test(text)) return true;
  if (/^\[图片\]$/.test(text)) return true;
  if (/^\[表情\]$/.test(text)) return true;
  if (/^@\S{1,20}$/.test(text)) return true;            // 纯 @
  if (/^[。，、！？~～.!?,\s]+$/.test(text)) return true; // 纯标点
  return false;
}

/** 信息量评分：越长越可能是"在说事"，带问号/数字/中文实词再加权。 */
function scoreText(text) {
  let score = Math.min(text.length, 120);
  if (/[？?]/.test(text)) score += 25;
  if (/\d/.test(text)) score += 12;
  if (/[“”"「」【】]/.test(text)) score += 8;
  return score;
}

/**
 * 把一个小时的消息压成一段摘要文本。
 * @returns {string} 形如「09:00-10:00 · 42 条 · 甲/乙/丙：要点1；要点2」
 */
export function buildBlockSummary(key, items, cfg, hourKey) {
  const chats = items.filter((m) => !m.isSelf);
  const mine = items.filter((m) => m.isSelf);

  // 发言人及条数（按出现次数排序，最多列 4 个）
  const speakCount = new Map();
  for (const m of chats) {
    const s = String(m.sender ?? '').trim() || '某人';
    speakCount.set(s, (speakCount.get(s) ?? 0) + 1);
  }
  const speakers = [...speakCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([s, n]) => (n > 1 ? `${s}×${n}` : s))
    .join('、');

  // 挑信息量最高的几句原话作为"要点"
  const points = chats
    .map((m) => textOf(m))
    .filter((t) => !isNoise(t))
    .map((t) => ({ t, s: scoreText(t) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, cfg.keyPointsPerHour)
    .map((x) => (x.t.length > cfg.keyPointChars ? x.t.slice(0, cfg.keyPointChars) + '…' : x.t));

  const hourLabel = hourKey.slice(hourKey.indexOf('T') + 1);
  const nextHour = String((Number(hourLabel.slice(0, 2)) + 1) % 24).padStart(2, '0');
  const head = `${hourLabel}-${nextHour}:00 · ${items.length} 条`
    + (mine.length ? `（我发言 ${mine.length}）` : '')
    + (speakers ? ` · 主要发言人：${speakers}` : '');

  let out = head;
  if (points.length) out += `\n  · ` + points.join('\n  · ');

  // 硬上限：宁可截断也不要让摘要本身膨胀
  if (out.length > cfg.maxBlockChars) out = out.slice(0, cfg.maxBlockChars - 1) + '…';
  return out;
}

/**
 * 压缩一个会话：把超出保留窗口的原文归并成小时块，并丢弃这些原文。
 *
 * @param {object} st 会话状态（会被就地修改，但只改 recentMessages / hourlySummaries）
 * @param {object} cfg 已归一化的配置（resolveHourlyConfig 的产物）
 * @param {number} now
 * @returns {{changed:boolean, blocksAdded:number, droppedMessages:number, totalBlocks:number}}
 */
export function compactConversation(st, cfg, now = Date.now()) {
  const result = { changed: false, blocksAdded: 0, droppedMessages: 0, totalBlocks: 0 };
  if (!st || typeof st !== 'object') return result;
  if (!Array.isArray(st.recentMessages)) st.recentMessages = [];
  if (!Array.isArray(st.hourlySummaries)) st.hourlySummaries = [];
  if (!cfg?.enabled) {
    result.totalBlocks = st.hourlySummaries.length;
    return result;
  }

  const cutoff = now - cfg.windowMs;
  // 没有时间戳的消息（少数工具写入项）视为"新"，保留 —— 宁可多留不可误删。
  const old = st.recentMessages.filter((m) => {
    const t = Number(m?.time);
    return Number.isFinite(t) && t > 0 && t < cutoff;
  });
  result.totalBlocks = st.hourlySummaries.length;
  if (!old.length) return result;

  // 按整点分组。已存在的块会被合并（幂等），不会重复追加。
  const byHour = new Map();
  for (const m of old) {
    const k = hourKeyOf(Number(m.time));
    if (!byHour.has(k)) byHour.set(k, []);
    byHour.get(k).push(m);
  }

  const existing = new Map(st.hourlySummaries.map((b) => [String(b.key), b]));
  for (const [key, items] of [...byHour.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const prev = existing.get(key);
    const merged = prev ? prev.items + items.length : items.length;
    // 合并时以"本次这批"的要点重建（上一批要点已在旧 text 里，这里保留旧的要点行更省事）
    const fresh = buildBlockSummary(key, items, cfg, key);
    const text = prev
      ? `${prev.text}\n  （本小时累计 ${merged} 条）`.slice(0, cfg.maxBlockChars)
      : fresh;
    existing.set(key, { key, text, items: merged, updatedAt: now });
    if (!prev) result.blocksAdded += 1;
  }

  // 落盘：按时间排序 + 只留最近 maxBlocks 个
  st.hourlySummaries = [...existing.values()]
    .sort((a, b) => (String(a.key) < String(b.key) ? -1 : 1))
    .slice(-cfg.maxBlocks);

  // 丢弃已归并的原文
  const dropped = new Set(old);
  st.recentMessages = st.recentMessages.filter((m) => !dropped.has(m));
  result.droppedMessages = old.length;
  result.totalBlocks = st.hourlySummaries.length;
  result.changed = result.droppedMessages > 0 || result.blocksAdded > 0;
  return result;
}

/**
 * 渲染供 prompt 注入的小时摘要文本。
 * @returns {string} 空串表示没有可注入的摘要
 */
export function renderHourlySummaries(st, cfg, opts = {}) {
  const blocks = Array.isArray(st?.hourlySummaries) ? st.hourlySummaries : [];
  if (!cfg?.enabled || !blocks.length) return '';
  const maxBlocks = Math.max(1, Number(opts.maxBlocks) || 6);
  const maxChars = Math.max(200, Number(opts.maxChars) || 1600);
  const recent = blocks.slice(-maxBlocks);

  // 标题里给出"原文保留窗口"，让模型知道自己为什么看不到更早的逐条记录
  const windowMin = Math.round(cfg.windowMs / 60000);
  let header = `【小时摘要】以下是较早时段已归档的聊天（原文已压缩，不再提供逐条记录）。`
    + `最近 ${windowMin} 分钟的消息仍以原文提供。需要回顾更早的内容请看这里，不要试图翻原始记录。`;

  const lines = [];
  for (const b of recent) {
    const line = String(b.text ?? '').trim();
    if (line) lines.push(line);
  }
  let out = header + '\n' + lines.join('\n');
  if (out.length > maxChars) {
    // 从最旧的块开始丢，保证最近的块完整
    const keep = [];
    let used = header.length;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (used + lines[i].length + 1 > maxChars) break;
      keep.unshift(lines[i]);
      used += lines[i].length + 1;
    }
    out = header + '\n' + keep.join('\n');
  }
  return out;
}
