// 每日群聊回复配额（本机部署新增）。
//
// 目的：给"每天在群里最多回多少条"一个确定性上限，并在接近上限时自动发出
// 一条预警，避免额度在不知不觉中烧完。
//
// 设计取舍：
//   · 只看群聊（key 形如 group:<id>）。私聊是你本人，不受配额限制。
//   · 计数按"实际发出的消息条数"，不是"轮次"——一条工具调用发 3 条就记 3 条。
//   · 跨天按本地日期（YYYY-MM-DD）自动归零，不依赖定时器：每次读写时比对日期。
//   · 状态与 qq-bridge 其余会话状态同源，落在 state/social-v2.json 的 dailyQuota。
//   · 校验失败一律 fail-open（放行），避免因为配额模块本身出错把整个桥接说不了话。

/** 默认配置：每天群聊上限 100 条，到 80 条时提醒并求投喂。 */
export const DEFAULT_DAILY_QUOTA = Object.freeze({
  enabled: true,
  groupLimit: 100,
  groupWarnAt: 80,
  privateLimit: 30,
  privateWarnAt: 24,
  warnMessage: 'token不多了，我要下线了，还想聊请找<YOUR_QQ>',
  warnImage: 'assets/feed-me.jpg',
  warnText: '我饿了，求投喂'
});

/** 本地日期键，例如 2026-10-13。 */
export function localDateKey(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 只对群聊会话计配额。 */
export function isGroupKey(key) {
  return typeof key === 'string' && key.startsWith('group:');
}

/** 从会话 key 里取出被限制对象（群号或 QQ 号）。 */
export function subjectOf(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  return m ? m[2] : null;
}

/**
 * 每日群聊配额用尽。调用方据此返回 429，而不是当成普通发送失败。
 */
export class QuotaExceededError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'QuotaExceededError';
    this.quotaExceeded = true;
    this.detail = detail;
  }
}

/**
 * 从配置里取出配额设置，缺省与非法值回退到默认。
 * @param {object} cfg - 已解析的 config.json。
 * @param {{root?: string}} [opts] - root 用于把相对图片路径解析成绝对路径（模块本身不做文件 IO）。
 */
export function resolveQuotaConfig(cfg, opts = {}) {
  const raw = cfg?.dailyQuota ?? {};
  const limit = Number(raw.groupLimit);
  const warnAt = Number(raw.groupWarnAt);
  const pLimit = Number(raw.privateLimit);
  const pWarnAt = Number(raw.privateWarnAt);
  const root = typeof opts.root === 'string' && opts.root ? opts.root : process.cwd();
  // 豁免名单：这些 QQ 号的私聊完全不受配额约束（不计数、不预警、不拦截）。
  const exemptOwners = new Set(
    (Array.isArray(raw.exemptOwners) ? raw.exemptOwners : [])
      .map((v) => String(v).trim())
      .filter((v) => /^\d+$/.test(v))
  );
  return {
    enabled: raw.enabled !== false,
    groupLimit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_DAILY_QUOTA.groupLimit,
    groupWarnAt: Number.isFinite(warnAt) && warnAt >= 0 ? Math.floor(warnAt) : DEFAULT_DAILY_QUOTA.groupWarnAt,
    privateLimit: Number.isFinite(pLimit) && pLimit > 0 ? Math.floor(pLimit) : DEFAULT_DAILY_QUOTA.privateLimit,
    privateWarnAt: Number.isFinite(pWarnAt) && pWarnAt >= 0 ? Math.floor(pWarnAt) : DEFAULT_DAILY_QUOTA.privateWarnAt,
    exemptOwners,
    warnMessage: typeof raw.warnMessage === 'string' && raw.warnMessage.trim()
      ? raw.warnMessage.trim()
      : DEFAULT_DAILY_QUOTA.warnMessage,
    // 预警配图：留空字符串表示不配图（只发文案）。
    warnImage: resolvePath(raw.warnImage, DEFAULT_DAILY_QUOTA.warnImage, root),
    warnText: typeof raw.warnText === 'string' && raw.warnText.trim()
      ? raw.warnText.trim()
      : DEFAULT_DAILY_QUOTA.warnText
  };
}

/** 把可能是相对路径的配置值解析成绝对路径。
 *  undefined（键缺失）→ 用 fallback（默认图）；
 *  null / 空串（显式关闭）→ 返回 null（不配图）。 */
function resolvePath(value, fallback, root) {
  let raw;
  if (value === undefined) raw = String(fallback ?? '');   // 键缺失：回落默认
  else if (value === null || value === '') raw = '';       // 显式关闭：不配图
  else raw = String(value).trim();
  if (!raw) return null;
  // 绝对路径按原样使用，其余相对仓库根解析。
  return /^[a-zA-Z]:[\\/]|^\\\\|^\//.test(raw) ? raw : root + '\\' + raw.replace(/^[\\/]+/, '');
}

/** 读取（必要时初始化）当日计数桶。 */
function bucketOf(store, dateKey) {
  const q = store.dailyQuota && typeof store.dailyQuota === 'object' ? store.dailyQuota : {};
  store.dailyQuota = q;
  if (q.date !== dateKey || typeof q.sent !== 'number' || !Number.isFinite(q.sent)) {
    q.date = dateKey;
    q.sent = 0;              // 群聊已发条数（各群共用）
    q.sentPrivate = 0;       // 私聊已发条数（各私聊共用）
    q.warned = false;        // 群聊预警线已提醒
    q.limitNotified = false; // 群聊上限已提醒
    q.warnedPrivate = false;
    q.limitNotifiedPrivate = false;
  }
  if (typeof q.sentPrivate !== 'number' || !Number.isFinite(q.sentPrivate)) q.sentPrivate = 0;
  return q;
}

/**
 * 发送前的闸门。群聊与私聊各有每日上限；豁免名单里的私聊对象不受限。
 * @returns {{allowed: boolean, error?: string, bucket: object, scope?: object}}
 */
export function checkDailyQuota(store, key, quotaCfg, now = Date.now()) {
  const dateKey = localDateKey(now);
  const bucket = bucketOf(store, dateKey);
  const scope = resolveScope(key, quotaCfg);
  if (!quotaCfg.enabled || !scope.limited) return { allowed: true, bucket, scope };
  if (bucket[scope.sentKey] >= scope.limit) {
    const left = Math.max(0, scope.limit - bucket[scope.sentKey]);
    const where = scope.kind === 'group' ? '群聊' : '私聊';
    return {
      allowed: false,
      error: `今日${where}回复额度已用完（${bucket[scope.sentKey]}/${scope.limit} 条，剩余 ${left}）—— 明天 0 点自动恢复。`,
      bucket,
      scope
    };
  }
  return { allowed: true, bucket, scope };
}

/**
 * 判断一个会话是否受限，并给出它的额度与计数键。
 * 豁免名单（exemptOwners）里的私聊对象：不计数、不预警、不拦截。
 */
function resolveScope(key, quotaCfg) {
  const k = String(key ?? '');
  if (k.startsWith('group:')) {
    return { limited: quotaCfg.groupLimit > 0, kind: 'group', limit: quotaCfg.groupLimit, warnAt: quotaCfg.groupWarnAt, sentKey: 'sent' };
  }
  if (k.startsWith('private:')) {
    const subject = subjectOf(k);
    if (subject && quotaCfg.exemptOwners?.has(subject)) {
      return { limited: false, kind: 'private', limit: 0, warnAt: 0, sentKey: 'sentPrivate', exempt: true };
    }
    return { limited: quotaCfg.privateLimit > 0, kind: 'private', limit: quotaCfg.privateLimit, warnAt: quotaCfg.privateWarnAt, sentKey: 'sentPrivate' };
  }
  return { limited: false, kind: 'other', limit: 0, warnAt: 0, sentKey: 'sent' };
}

/**
 * 发送成功后记账，并判断是否需要补发预警。
 *
 * 通知是结构化的：文本用 warnMessage（说明额度用尽），配图用 warnImage + warnText
 * （求投喂）。是否真的有那张图由桥接落地时判断 —— 本模块不做文件 IO。
 *
 * @param {number} sentCount - 本次实际发出的条数。
 * @returns {{notice: {reason: string, image: string|null, text: string}|null, bucket: object}}
 */
export function recordDailyQuota(store, key, sentCount, quotaCfg, now = Date.now()) {
  const dateKey = localDateKey(now);
  const bucket = bucketOf(store, dateKey);
  const scope = resolveScope(key, quotaCfg);
  if (!quotaCfg.enabled || !scope.limited || sentCount <= 0) {
    return { notice: null, bucket, scope };
  }
  bucket[scope.sentKey] += sentCount;

  const warnedKey = scope.kind === 'group' ? 'warned' : 'warnedPrivate';
  const limitKey = scope.kind === 'group' ? 'limitNotified' : 'limitNotifiedPrivate';
  const build = (reason) => ({
    notice: {
      reason,
      kind: scope.kind,
      image: quotaCfg.warnImage ?? null,
      text: quotaCfg.warnText || DEFAULT_DAILY_QUOTA.warnText,
      message: quotaCfg.warnMessage
    },
    bucket,
    scope,
    reason
  });

  // 跨过预警线 → 补发一次提醒；跨过上限 → 再补发一次（把提醒本身当最后一条）。
  if (!bucket[warnedKey] && scope.warnAt > 0 && bucket[scope.sentKey] >= scope.warnAt) {
    bucket[warnedKey] = true;
    return build('warn');
  }
  if (!bucket[limitKey] && bucket[scope.sentKey] >= scope.limit) {
    bucket[limitKey] = true;
    return build('limit');
  }
  return { notice: null, bucket, scope };
}

/**
 * 给会话状态做一次性迁移：老状态文件没有 dailyQuota 时补上，并纠正跨天残留。
 * @returns {object} 当日计数桶（可写，调用方负责保存）。
 */
export function ensureDailyQuotaState(store, now = Date.now()) {
  return bucketOf(store, localDateKey(now));
}

/** 只读查询，供控制台/调试使用。 */
export function describeDailyQuota(store, quotaCfg, now = Date.now()) {
  const dateKey = localDateKey(now);
  const q = store?.dailyQuota ?? {};
  const sameDay = q.date === dateKey;
  const sent = sameDay && typeof q.sent === 'number' ? q.sent : 0;
  return {
    date: dateKey,
    sent,
    limit: quotaCfg.groupLimit,
    warnAt: quotaCfg.groupWarnAt,
    remaining: Math.max(0, quotaCfg.groupLimit - sent),
    warned: sameDay ? q.warned === true : false,
    limitNotified: sameDay ? q.limitNotified === true : false,
    enabled: quotaCfg.enabled
  };
}
