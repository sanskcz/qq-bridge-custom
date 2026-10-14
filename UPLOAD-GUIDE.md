# 上传到 GitHub 的步骤

这个压缩包解压后就是**仓库的完整内容**（文件在根目录，没有多余的外层文件夹）。
按下面的步骤上传即可，**全程在网页上操作，不需要装 git**。

---

## 0. 上传前请再确认两件事

**① 压缩包里没有这些东西**（已排除，但你最好心里有数）：

| 已排除 | 原因 |
|---|---|
| `config.json` | 你的实机配置，含网关 accessToken 与你自己的 QQ 号 |
| `state/` | 运行状态：**聊天记录、各会话令牌、控制台令牌、日志** |
| `assets/feed-me.jpg` 等 | **你的微信收款码**（这个绝对不能公开） |
| `node_modules/` `.pnpm-store/` | 依赖与缓存，体积大且可由 `pnpm i` 重建 |
| `audio/` | 你个人的语音素材 |
| `README-本机部署.md` | 含你本机的令牌链接与真实 QQ 号 |

**② 已做的脱敏**：真实 QQ 号已全部替换为 `<YOUR_QQ>` 占位符。

---

## 1. 新建仓库

1. 打开 https://github.com/new
2. **Repository name** 建议：`qq-bridge-console` 或 `qq-bridge-custom`
3. **Description** 建议：
   ```
   基于 Derpyu520/qq-bridge 的修改版：按时滚动记忆、每日配额预警、可视化控制台（人设/预警/会话模式）
   ```
4. 选 **Public**
5. ⚠️ **不要**勾选 "Add a README file" / "Add .gitignore" / "Choose a license"
   —— 这些文件压缩包里都有了，勾了会造成冲突
6. 点 **Create repository**

## 2. 上传文件

新建后的页面上会有一个 **uploading an existing file** 链接，点它。
（或者直接访问 `https://github.com/<你的用户名>/<仓库名>/upload/main`）

1. 把压缩包**解压**到一个文件夹
2. 打开那个文件夹，**全选里面的所有文件和文件夹**（Ctrl+A）
3. 拖进 GitHub 的上传区域
   - ⚠️ 注意：GitHub 网页上传**有单次文件数量与体积限制**（单文件 ≤ 25 MB，
     单次提交建议不超过 100 个文件）
   - 这个包有 **155 个文件 / 2.5 MB**，如果一次拖不上去，分两三次提交即可
   - 先传顶层文件和 `src/`，再传 `docs/`、`scripts/`、`public/` 等目录
4. 下方的 **Commit changes** 填一句说明，例如
   `Initial commit: qq-bridge 修改版（控制台 + 滚动记忆 + 配额预警）`
5. 点 **Commit changes**

## 3. 上传后建议做的事

**① 改 About 区**
仓库首页右上角齿轮 → 填 Description，并加上 Topics：
`qq` `deepseek` `dsh` `onebot` `snowluma` `chatbot` `windows`

**② 检查首页 README 是否正确显示**
应该能看到最顶上那段「本仓库是上游的个人修改版」的说明。

**③ 确认没有敏感文件混进去**
在仓库页面按 `t` 打开文件搜索，输入 `config.json`、`feed-me`、`state` —— 都不该有结果。

**④ 如果你之后想用 git 管理**
安装 git 后：
```bash
git clone https://github.com/<你的用户名>/<仓库名>.git
cd <仓库名>
```
然后把解压出来的内容复制进去（`config.json` 和 `state/` 会被 `.gitignore` 自动忽略）。

---

## 4. 别人拿去怎么用

压缩包里的 `MODIFICATIONS.md` 末尾有「部署前请改这些」，主要三处：

1. `config.json`（从 `config.example.json` 复制）—— 填 `ownerQQ`、`allow.groups`、
   `snowluma.accessToken`
2. `dsh-start.bat` / `dsh-stop.bat` 顶部的 `NODE` 与 `SNOWLUMA` 路径
3. 人设 —— 改 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 后跑
   `node scripts/build-agent-preset-patches.mjs` 并重启 DSH

---

## 5. 关于协议与署名

- 上游是 **MIT**，`LICENSE` 里保留了原始版权声明
  （Copyright © 2026 Derpyu520 and qq-bridge / QSH contributors），
  并注明本仓库是修改版 —— 这是 MIT 的要求，**不要删掉那两行**
- README 顶部也已标明「基于 Derpyu520/qq-bridge 修改」
- 如果你愿意，可以给上游提 PR 把有用的部分回馈回去（尤其那份 DSH bug 报告）
