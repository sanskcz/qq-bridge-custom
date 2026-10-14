// 向主人号发送告别消息。供 dsh-stop.bat 在"停服务 + 关机"前调用。
//
// 为什么独立成脚本而不是走桥接 API：
//   这一步发生在**停掉桥接之前**，此刻 OneBot HTTP API 仍然可用，
//   直接调它最直接，也不依赖桥接进程的状态。发送失败不影响关机流程（只记日志）。
//
// 用法：node tools\scripts\farewell.mjs ["自定义文案"]

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
  console.error('[farewell] 找不到仓库根目录');
  process.exit(2);
}

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
} catch (error) {
  console.error('[farewell] 读配置失败：' + (error?.message ?? error));
  process.exit(2);
}

const text = String(process.argv[2] ?? cfg.farewell?.text ?? '主人再见，哦鲸鲸睡了');
const target = Number(cfg.farewell?.to ?? cfg.bootGreeting?.to ?? 0);

if (!Number.isSafeInteger(target) || target <= 0) {
  console.error('[farewell] 未配置有效的收件人（farewell.to / bootGreeting.to）');
  process.exit(2);
}

const base = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
try {
  const res = await fetch(base + '/send_private_msg', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cfg.snowluma?.accessToken ? { authorization: 'Bearer ' + cfg.snowluma.accessToken } : {})
    },
    body: JSON.stringify({ user_id: target, message: [{ type: 'text', data: { text } }] }),
    signal: AbortSignal.timeout(15000)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
    throw new Error(body.wording || body.message || ('HTTP ' + res.status));
  }
  console.log(`[farewell] 已向 ${target} 发送：${text}`);
  process.exit(0);
} catch (error) {
  // 只告警，不阻塞关机 —— 用户已经确认要关了，不能因为一条消息发不出去就卡住。
  console.error(`[farewell] 发送失败（不影响关机）：${error?.message ?? error}`);
  process.exit(1);
}
