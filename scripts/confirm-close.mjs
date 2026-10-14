// 关闭前的确认弹窗。供 dsh-stop.bat 调用。
//
// 为什么用 Node 而不是在 .bat 里直接写：
//   cmd.exe 按 ANSI 代码页逐字节解析 .bat，中文提示会被误读；
//   而"是/否"对话框需要中文文案。放在 Node 里调用可以两全：
//   .bat 保持纯 ASCII，弹窗文案不受编码影响。
//
// 退出码：0 = 用户确认关闭；1 = 取消或无法弹窗（调用方据此中止，不做任何改动）。

import { execFileSync } from 'node:child_process';

const title = process.argv[2] ?? 'QQ 聊天';
const message = process.argv[3] ?? '确定要关闭 QQ 聊天吗？';

// 用 PowerShell 的 WinForms MessageBox；NoDefault 无意义，这里用 YesNo + Question 图标。
const ps = [
  'Add-Type -AssemblyName System.Windows.Forms;',
  `$r=[System.Windows.Forms.MessageBox]::Show(${JSON.stringify(message)},${JSON.stringify(title)},`,
  '[System.Windows.Forms.MessageBoxButtons]::YesNo,',
  '[System.Windows.Forms.MessageBoxIcon]::Question);',
  "if($r -eq 'Yes'){exit 0}else{exit 1}"
].join(' ');

try {
  execFileSync('powershell', ['-NoProfile', '-STA', '-Command', ps], { stdio: 'ignore', timeout: 120000 });
  process.exit(0);   // 弹窗返回 Yes
} catch (error) {
  // 非零退出（用户选了 No）或弹窗失败 —— 两种情况都当作"不要关"，
  // 这是 fail-safe 的方向：宁可不动，也不要误关。
  if (error?.status === 1) process.exit(1);
  console.error('[confirm] 无法弹出确认框，已按"取消"处理：' + (error?.message ?? error));
  process.exit(1);
}
