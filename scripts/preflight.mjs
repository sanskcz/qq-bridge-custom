// qq-bridge 体检：离线只读，不改任何配置。
// 用法：node tools\scripts\preflight.mjs
// 位置无关：从脚本所在目录逐级向上找含 config.json 与 src/bridge.js 的那一层作为仓库根。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findRoot(start) {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'config.json')) && fs.existsSync(path.join(dir, 'src', 'bridge.js'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const ROOT = findRoot(__dirname);
if (!ROOT) {
  console.error('找不到 qq-bridge 仓库根目录（未发现 config.json + src/bridge.js）。');
  process.exit(2);
}

const ok = (m) => console.log('  ✅ ' + m);
const bad = (m) => console.log('  ❌ ' + m);
const info = (m) => console.log('  ·  ' + m);

console.log('=== qq-bridge 体检 ===');

// 1. 配置
let cfg = null;
try {
  cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  ok('config.json 可读且是合法 JSON');
  info(`ownerQQ=${cfg.ownerQQ}  private=[${(cfg.allow?.private ?? []).join(', ')}]  groups=[${(cfg.allow?.groups ?? []).join(', ')}]`);
  if (cfg.allowAllWhenEmpty === true) {
    // 本机刻意配置：私聊对所有人开放，群聊仍由非空的 allow.groups 约束。
    const groupsOpen = (cfg.allow?.groups ?? []).length === 0;
    if (groupsOpen) bad('allowAllWhenEmpty=true 且 allow.groups 为空 —— 所有群都会放行，请至少填一个群');
    else info('allowAllWhenEmpty=true（私聊对所有人开放；群聊受 allow.groups 约束）');
  } else {
    ok('allowAllWhenEmpty=false（fail-closed）');
  }
  if (!cfg.snowluma?.accessToken) bad('snowluma.accessToken 为空');
  else ok('snowluma.accessToken 已填');
} catch (e) {
  bad('config.json 读取失败: ' + e.message);
}

// 2. SnowLuma WebUI
async function port(url, label) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    ok(`${label} 在响应（HTTP ${r.status}）`);
    return true;
  } catch (e) {
    bad(`${label} 无响应（${e.cause?.code ?? e.name}）—— 可能没启动`);
    return false;
  }
}

const webui = await port('http://127.0.0.1:5099/', 'SnowLuma WebUI :5099');

// 3. OneBot HTTP API + token 有效性
if (cfg?.snowluma?.httpUrl && cfg?.snowluma?.accessToken) {
  try {
    const r = await fetch(cfg.snowluma.httpUrl + '/get_login_info', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.snowluma.accessToken },
      body: '{}',
      signal: AbortSignal.timeout(8000)
    });
    const j = await r.json();
    if (j.status === 'ok') {
      ok(`OneBot 鉴权通过，登录账号 ${j.data.user_id}（${j.data.nickname}）`);
      if (String(j.data.user_id) !== String(cfg.ownerQQ)) {
        bad(`账号不匹配：配置 ownerQQ=${cfg.ownerQQ}，实际在线 ${j.data.user_id}`);
      }
    } else {
      bad('OneBot 返回非 ok: ' + JSON.stringify(j).slice(0, 200));
    }
  } catch (e) {
    bad(`OneBot HTTP API 不可用（${e.cause?.code ?? e.name}）—— 检查端口与 token`);
  }
}

// 4. 桥接控制台
await port('http://127.0.0.1:3100/', '桥接控制台 :3100');

// 5. DSH
if (cfg?.dsh?.baseUrl) await port(cfg.dsh.baseUrl + '/', 'DSH ' + cfg.dsh.baseUrl);

// 6. 启动器
const launcher = path.join(ROOT, 'dsh-start.bat');
console.log(fs.existsSync(launcher) ? '  ✅ 启动器存在: dsh-start.bat' : '  ❌ 缺少 dsh-start.bat');

console.log('=== 体检结束 ===');
console.log('提示：若 :3100 无响应，双击桌面「启动 QQ 聊天」（或直接运行 dsh-start.bat）。');
