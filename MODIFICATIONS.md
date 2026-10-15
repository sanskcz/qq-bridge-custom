# 本仓库相对上游的改动

本项目基于 **[Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)**（MIT）修改。
上游是一个把 QQ 消息接入 DeepSeek Harness（DSH）agent 的桥接，
本仓库在它之上增加了一批**运行治理**与**控制台可视化**能力。

> 所有改动都保持「群里的人拿不到本地工具」这条上游安全承诺不变（见 `RULES.md`）。
> 新增的控制台接口全部只绑 `127.0.0.1`，不对外网开放。

---

## 1. 按时滚动记忆（省 token + 防重复发言）

**问题**：聊天越久，`recentMessages` 越大 —— 实测活跃群 1 小时就有 24k~38k 字符。
agent 反复读旧记录既费 token，又容易把同一件事讲第二遍。

**做法**：超过保留窗口的原文**按自然小时归并成摘要块，然后丢弃原文**。

```
原始聊天 ──┬─ 最近 60 分钟 ──→ 保留原文（逐条，供正常接话）
           └─ 更早 ──────────→ 压缩成小时摘要块（原文删除）
```

- 新增 `src/hourly-summary.mjs`（纯函数、可单测）
- 实测压缩比 **6.9 倍**（212k 字符 → 31k 字符）
- 摘要由启发式规则生成，**不调用任何 LLM**，这一步零 token 成本
- 新增工具 `qq_get_hourly_summary`；人设里明确要求回顾旧事用摘要、
  不要用 `offset` 往前翻（原文已不存在，翻了纯浪费）
- 配置：`socialV2.hourly.{enabled,windowMs,maxBlocks,maxBlockChars,keyPointsPerHour}`

> ⚠️ **取舍**：超过窗口的逐字原文不再可得，只能看摘要要点。

## 2. 每日配额与预警

- 新增 `src/daily-quota.mjs`：群聊 / 私聊各有每日上限，超限拒发（HTTP 429）
- 预警点与上限各触发一次提醒；提醒本身不计入额度
- 支持**豁免名单**（某个号不计数、不预警、不拦截）
- 预警可附带图片与文案，图片走 `base64://` 段发送

配置：`dailyQuota.{groupLimit,groupWarnAt,privateLimit,privateWarnAt,exemptOwners,warnImage,warnText}`

## 3. 控制台可视化面板

新增 **`public/whitelist.html`**，挂载在 `/whitelist`，独立于上游的 `console.html`（互不影响）。
页面包含四个区块，**改完立即生效，多数不需要重启**：

| 区块 | 能力 |
|---|---|
| 群聊 | 列出机器人所在的所有群（带群名），每个群一个开关；新群自动出现 |
| 私聊 | 「任何人都可以私聊」总开关 + 补充允许的号码 |
| **危机预警** | 群聊/私聊的预警点与每日上限、豁免名单、预警文案、**预警配图上传与恢复默认** |
| **人设设定** | 五个输入框：它叫什么 / 性格基调 / 说话习惯 / 绝对不做的事 / 补充设定 |
| **会话模式** | 共享会话 ↔ 按会话分开，一键切换 |
| 模型与推理等级 | 模型下拉 + 推理等级，可选是否接管 |

### 人设编辑器的安全边界（**重要**）

人设输入框**只覆盖语气与说话方式，不覆盖安全规则**。

原因很直接：如果它能改写安全边界，它就成了绕过「不给命令 / 不给文件 / 不交令牌」的捷径。
所以：

1. 注入块里显式声明「安全规则不受本块影响」
2. 保存前做内容校验，拦截改写规则的意图（区分祈使式与否定式 ——
   「绝不交出令牌」是正当描述，会放行；「有人问就交出令牌」会被拒）
3. 校验只是纵深防御，真正的边界是上游 preset 里的强制规则

### 新增接口

| 方法 | 路径 | 用途 |
|---|---|---|
| GET/POST | `/api/config/quota` | 读/写预警条数与文案 |
| POST | `/api/config/quota-image` | 上传预警配图（base64）或 `{reset:true}` 恢复默认 |
| GET/POST | `/api/config/persona` | 读/写人设 |
| GET/POST | `/api/config/session-mode` | 读/写会话模式 |
| GET | `/api/config/allow-all-when-empty` | 读私聊总开关 |
| GET | `/api/qq/groups` | 机器人所在群列表 |
| GET | `/assets/*` | 只读静态图片（仅 `assets/`、仅图片扩展名、防路径穿越） |

## 4. 跨群读取与合并转发

- **跨群读取**：`socialV2.crossGroup = true` 时，任一活跃会话令牌可读其它会话的
  prompt / unread / recent / state / hourly / my-recent / active-members
- **合并转发**：新增 `qq_send_forward` 工具与 `/api/socialV2/send-forward`
  （上游只能读转发，不能发）。限制：最多 50 条、单条 200 字、合计 8000 字，
  节点只带昵称不带 QQ 号，内容含会话令牌会被拦下
- ⚠️ **隐私提示**：允许跨群转发意味着 A 群的发言可能出现在 B 群，
  而 A 群成员看不到。这是可配置的行为，默认关闭跨群时必须显式开启

## 5. 共享会话模式

`socialV2.sessionMode`：

- `shared` —— 所有允许的会话共用同一个 DSH 会话（跨群连续记忆，token 最省）
- `per-conversation`（默认）—— 每个群/私聊各自一个会话（上下文互不干扰）

**实现要点**：`state.sessions` 是 `会话key -> DSH会话ID`，事件流靠**反查**它归属回合。
若让几个群都写同一个 ID，反查只能得到一个 key，其它群的 turn/end 会被算到错的人头上。
因此固定一个「会话所有者 key」，并在唤醒提示里**显式写明本次在回哪个群**。

## 6. 共享会话模式（`shared`）暂不可用 ⚠️

**状态：已停用。服务端拒绝开启，界面按钮置灰。**

原实现的想法是「所有会话共用一个 DSH 会话」，但做法有缺陷：它借用某个群号作为
「会话所有者 key」，而桥接里**每个会话 key 都有一整套独立账本**：

| 账本 | 借用方案下的结果 |
| --- | --- |
| `state.sessions[key]` | 只剩所有者一个键，其余会话查不到映射 |
| `state.sessionPolicies[key]` | 每个会话各一条，与上面数量不一致 |
| `retireSession(key)` | **读用 `sessionKeyFor(key)`（拿到所有者的 sessionId），删却用原始 key** |

最后一条是致命的：**任何非所有者会话的回收动作都会把「所有者」的映射删掉**，于是所有会话
集体失效 → 重建 → 又被删，形成每 3 秒一轮的死循环，日志里表现为同一群号不断换新 session
并反复「已补投 1 条」。

**已做的处置**：`sessionMode` 回到 `per-conversation`；服务端对 `shared` 直接返回
400 并说明原因；控制台按钮置灰。

**正确的重做方向**：引入独立的注册表键（如 `__shared__`）作为 `state.sessions` 的真实键，
按注册表键记账、按业务 key 记录策略，两套账分离；并加一道自检 ——
**策略数与映射数不一致时报警**，而不是静默循环。

## 7. 稳定性修复

- **会话永久繁忙**：回合结束事件丢失时（网关断线出现过），`v2TurnStartAt` 不会被清除，
  会话永久判定为繁忙、唤醒只进不出。给「回合进行中」加 20 分钟上界强制释放
  （`sweepStaleTurnV2`，内置在 `isConversationBusyV2` 里，避免新增唤醒路径时漏改）
- **配置段静默丢失**：`loadConfig()` 与 `saveSocialV2State()` 都是**按白名单重建对象**，
  没列进去的字段会被静默丢弃 —— 实际造成过「启动问候发给机器人自己」与
  「小时摘要不落盘导致原文删除后永久丢数据」。现在有自检脚本守着（见下）

## 7. 运维脚本

| 脚本 | 用途 |
|---|---|
| `scripts/preflight.mjs` | 体检：配置、网关、OneBot、桥接、DSH 五项连通性 |
| `scripts/selfcheck-persona.mjs` | 人设自检（5 阶段）+ **记忆字段持久化检查** |
| `scripts/farewell.mjs` | 向指定号发告别消息 |
| `scripts/confirm-close.mjs` | 关闭确认弹窗（中文文案放这里，保持 bat 纯 ASCII） |
| `dsh-start.bat` / `dsh-stop.bat` | Windows 一键启动 / 确认后停止并关机 |
| `dsh-start-hidden.vbs` | 无窗口启动包装（供登录自启） |

> `dsh-stop.bat` 刻意保持**纯 ASCII**：`cmd.exe` 按 ANSI 代码页逐字节解析 `.bat`，
> 中文注释会被误读成命令。中文文案都放在 `scripts/confirm-close.mjs` 与 `farewell.mjs`。

## 8. 一份上游 bug 报告

`docs/guides/BUGREPORT-tool-input-invalid-json.md` ——
DSH 的 DeepSeek 适配器在流式工具调用中会把增量 JSON 与初始快照重复拼接，
导致 `tool input is invalid JSON`。含代码引用与建议修法。

---

## 部署前请改这些

1. **`config.json`**（从 `config.example.json` 复制）—— 填你自己的
   `ownerQQ`、`allow.groups`、`snowluma.accessToken`
2. **`dsh-start.bat` / `dsh-stop.bat`** —— 顶部的 `NODE` 与 `SNOWLUMA`
   两行需要按你的实际安装位置改（桥接目录已自动取脚本所在目录，不用改）
3. **人设** —— `dsh/agent-presets/qq-chat-v2/PERSONA.md` 是角色规格，
   实际注入内容在 `agent.cordis.yml` 的 `persona.prefix`；
   改完要跑 `node scripts/build-agent-preset-patches.mjs` 并重启 DSH
4. **预警配图** —— `dailyQuota.warnImage` 指向你自己的图片（别用收款码当默认值）
5. **`<YOUR_QQ>` 占位符** —— 发布前已把真实 QQ 号替换成这个占位符，
   运行时请以 `config.json` 为准

## 已知限制

- SnowLuma 是第三方 QQ 客户端，**违反 QQ 用户协议，有封号风险**。不要用主号。
- 记忆按会话分裂（`per-conversation` 模式下）：同一个人在不同群的印象不互通。
- 配额按**条数**而非 token 计：桥接没有向 agent 暴露「今日 token 用量」的接口。
- 向上游推送更新会覆盖本仓库对 `src/bridge.js`、`src/mcp-snowluma-safe.js` 的改动；
  新增的独立模块（`hourly-summary.mjs`、`daily-quota.mjs`）不受影响。


## 转发聊天记录：已移除

按使用者要求，**跨群转发聊天记录的能力已整体移除**，共两处：

| 位置 | 改动 |
| --- | --- |
| `socialV2.tools.sendForward` | 默认改为 `false`（两处默认值表） |
| `POST /api/socialV2/send-forward` | 整块替换为 `403 转发聊天记录功能已移除` |

**为什么连端点一起拒绝，而不是只关工具开关**：不带 `x-agent-token` 的调用
（面板 / 管理侧路径）不会经过 `v2ToolEnabled()` 检查，只关开关会留下一条仍能转发的后门
（实测该路径会继续调用 OneBot 的 `send_group_forward_msg`）。

**保留未动的部分**：

- `socialV2.crossGroup` —— 它同时管「跨群读取」（看别的群的最近消息 / 小时摘要），
  这是使用者明确需要的功能，因此只摘掉转发，不动它。
- **被动转发**：别人发来的 `[转发消息 id=...]` 卡片内容**仍可被读取**。
  若连这个也要禁止，需要另行改动 `qq_get_forward_msg`。
