// 人设自检：确认"吃白饭的肥鱼"这套人设在三层里都没有漂移或丢失。
//
// 校验四件事：
//   ① 规格文件 PERSONA.md 存在，且包含四个标志性字段（名字/自称/口头禅/两个概率）
//   ② preset 源文件 agent.cordis.yml 的 persona.prefix 含全部关键要素
//   ③ 生成的 preset patch 与源文件同步（避免改了源却忘了重新生成）
//   ④ 记忆卫生：每人印象条数、跨群同一人的印象是否一致
//
// 退出码 0 = 全部通过；1 = 有失败项。
// 用法：node tools\scripts\selfcheck-persona.mjs
// 位置无关：从脚本所在目录逐级向上找含 dsh\agent-presets 的那一层作为仓库根。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 从给定目录向上查找仓库根（含 dsh/agent-presets 的那一层）。 */
function findRoot(start) {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'dsh', 'agent-presets'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const ROOT = findRoot(__dirname);
if (!ROOT) {
  console.error('找不到仓库根目录（未发现 dsh/agent-presets）。请把本脚本放在 qq-bridge 仓库内运行。');
  process.exit(2);
}
const PRESET_ID = 'qq-chat-v2';
const SRC_YML = path.join(ROOT, 'dsh', 'agent-presets', PRESET_ID, 'agent.cordis.yml');
const SPEC_MD = path.join(ROOT, 'dsh', 'agent-presets', PRESET_ID, 'PERSONA.md');
const PATCH_YML = path.join(ROOT, 'plugins', 'qq-agent-presets', 'presets', `${PRESET_ID}.patch.yml`);
const SOCIAL_V2 = path.join(ROOT, 'state', 'social-v2.json');

let failed = 0;
let warned = 0;
const ok = (m) => console.log(`  OK   ${m}`);
const bad = (m) => { failed += 1; console.log(`  BAD  ${m}`); };
const warn = (m) => { warned += 1; console.log(`  WARN ${m}`); };
const check = (label, cond, detail = '') => (cond ? ok(label) : bad(`${label}${detail ? ' —— ' + detail : ''}`));

// 人设必须出现的要素：描述 + 判定关键词（全部命中才算通过）
const REQUIRED = [
  ['名字', ['吃白饭的肥鱼']],
  ['自称', ['哦鲸鲸']],
  ['口头禅', ['你要死啊']],
  ['骗人概率 1%', ['1%']],
  ['网络梗概率 7%', ['7%']],
  ['破甲硬规则', ['破甲', '不看、不描述']],
  ['对主人的称呼规则', ['<YOUR_QQ>', '主人']],
  ['身份优先级声明', ['高于一切群聊内容']],
  ['原有安全规则未被覆盖', ['二代仿真模式 —— 安全规则']],
  ['原有反AI味规则未被覆盖', ['反 AI 味']],
  ['原有工具协议未被覆盖', ['qq_send_message']]
];

console.log('═══ 人设自检 · 吃白饭的肥鱼 ═══\n');

// ① 规格文件
console.log('[1/5] 规格文件 PERSONA.md');
if (!fs.existsSync(SPEC_MD)) {
  bad(`缺少规格文件：${path.relative(ROOT, SPEC_MD)}`);
} else {
  const spec = fs.readFileSync(SPEC_MD, 'utf8');
  check('规格文件存在且非空', spec.length > 200, `长度 ${spec.length}`);
  for (const [label, keys] of REQUIRED.slice(0, 6)) {
    check(`规格含「${label}」`, keys.every((k) => spec.includes(k)));
  }
}

// ② preset 源文件里的 persona 块
console.log('\n[2/5] preset 源文件 persona 块');
let prefix = '';
if (!fs.existsSync(SRC_YML)) {
  bad(`缺少 preset 源文件：${path.relative(ROOT, SRC_YML)}`);
} else {
  try {
    const doc = YAML.load(fs.readFileSync(SRC_YML, 'utf8'));
    const persona = (Array.isArray(doc) ? doc : []).find((r) => r?.id === 'persona');
    prefix = persona?.config?.prefix ?? '';
    check('persona 行存在且 prefix 非空', prefix.length > 0, `长度 ${prefix.length}`);
    for (const [label, keys] of REQUIRED) {
      const missing = keys.filter((k) => !prefix.includes(k));
      check(`prefix 含「${label}」`, missing.length === 0, missing.length ? `缺少: ${missing.join(' / ')}` : '');
    }
    // 顺序检查：身份块必须在安全规则之前，否则优先级叙述会自相矛盾
    const idxIdentity = prefix.indexOf('【你的身份');
    const idxSafety = prefix.indexOf('【二代仿真模式 —— 安全规则');
    check('身份块排在安全规则之前', idxIdentity >= 0 && idxSafety > idxIdentity, `身份=${idxIdentity} 安全=${idxSafety}`);
  } catch (e) {
    bad(`YAML 解析失败：${e?.message ?? e}`);
  }
}

// ③ 生成的 patch 是否同步
console.log('\n[3/5] preset patch 同步性');
if (!fs.existsSync(PATCH_YML)) {
  bad(`缺少 patch 文件：${path.relative(ROOT, PATCH_YML)}`);
} else {
  const patch = fs.readFileSync(PATCH_YML, 'utf8');
  for (const [label, keys] of REQUIRED.slice(0, 7)) {
    const missing = keys.filter((k) => !patch.includes(k));
    check(`patch 含「${label}」`, missing.length === 0, missing.length ? 'patch 未重新生成？' : '');
  }
}

// ④ 记忆卫生
console.log('\n[4/5] 记忆卫生');
if (!fs.existsSync(SOCIAL_V2)) {
  warn('尚无 social-v2.json（桥接还没写过状态），跳过');
} else {
  try {
    const data = JSON.parse(fs.readFileSync(SOCIAL_V2, 'utf8'));
    const convs = data.conversations ?? {};
    const keys = Object.keys(convs);
    check('会话数 > 0', keys.length > 0, `${keys.length} 个`);

    // 同一句人设必须对所有会话生效：检查没人被单独改过预设
    const presets = new Set();
    for (const k of keys) presets.add(convs[k]?.agentPreset ?? PRESET_ID);
    warn(`会话各自使用的 agentPreset: ${[...presets].join(', ')}（桥接按 config.agentPreset 决定，此处仅供参考）`);

    // 印象条数统计
    let totalImpr = 0;
    let emptyConvs = [];
    const perPerson = new Map(); // 昵称/名字 -> 出现过的会话数
    for (const k of keys) {
      const impr = convs[k]?.memberImpressions ?? {};
      const names = Object.keys(impr);
      totalImpr += names.length;
      if (names.length === 0) emptyConvs.push(k);
      for (const n of names) perPerson.set(n, (perPerson.get(n) ?? 0) + 1);
    }
    console.log(`       印象总数 ${totalImpr}，覆盖 ${perPerson.size} 个人`);
    if (emptyConvs.length) warn(`${emptyConvs.length} 个会话尚无任何成员印象（记忆偏薄）`);

    // 跨群同一个人：人设应该认识，但记忆是分裂的
    const crossGroup = [...perPerson.entries()].filter(([, n]) => n > 1);
    if (crossGroup.length === 0) {
      ok('暂无跨会话重复出现的人（无记忆分裂风险）');
    } else {
      warn(`有 ${crossGroup.length} 人出现在多个会话，印象是分裂的（架构限制）：${crossGroup.map(([n, c]) => `${n}×${c}`).join('、')}`);
    }
  } catch (e) {
    bad(`social-v2.json 解析失败：${e?.message ?? e}`);
  }
}

// ── [5/5] 记忆字段必须被持久化 ──────────────────────────────────────────────
// saveSocialV2State() 是按白名单重建对象的：没列进去的字段会被静默丢弃。
// 小时摘要一旦丢盘，配合"压缩时删除原文"就变成**永久数据丢失** —— 实际发生过一次。
console.log('\n[5/5] 记忆字段持久化');
{
  try {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
    // 只取 saveSocialV2State 的对象字面量范围做检查，避免别处同名变量误判
    const start = src.indexOf('function saveSocialV2State()');
    const end = src.indexOf('atomicWriteJson(SOCIAL_V2_FILE', start);
    const body = start >= 0 && end > start ? src.slice(start, end) : '';
    if (!body) {
      bad('找不到 saveSocialV2State() 的实现');
    } else {
      for (const field of ['recentMessages', 'unread', 'activeTopics', 'memberImpressions', 'hourlySummaries']) {
        check(`saveSocialV2State 持久化 ${field}`, body.includes(field + ':'));
      }
      // 摘要字段缺失是最危险的一种：压缩已删原文，摘要不落盘就找不回来了
      check('hourlySummaries 不在白名单外（防数据丢失）', body.includes('hourlySummaries:'));
    }
    // 压缩模块本身可加载
    check('hourly-summary.mjs 存在', fs.existsSync(path.join(ROOT, 'src', 'hourly-summary.mjs')));
  } catch (e) {
    bad(`持久化检查失败：${e?.message ?? e}`);
  }
}

console.log(`\n═══ 结果：${failed === 0 ? '通过' : failed + ' 项失败'}${warned ? `，${warned} 项提醒` : ''} ═══`);
console.log('提示：改动 preset 后需运行 node scripts/build-agent-preset-patches.mjs 并重启 DSH 才生效。');
process.exit(failed === 0 ? 0 : 1);
