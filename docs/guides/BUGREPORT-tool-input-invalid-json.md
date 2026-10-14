# Bug: `DeepSeek Messages stream: tool input is invalid JSON` —— 工具参数流式拼接会丢弃/重复起始 input

## 环境

- DSH Desktop `0.2.0-rc.2`
- provider: `deepseek-account`（DeepSeek Messages 协议）
- 模型: `deepseek-flash`
- 报错频率: 间歇性，同一天内出现多次
- 现场工具: 若干 MCP 工具（入参最大的是"发送多条消息"这类 array-of-string 参数）

## 现象

会话里随机出现：

```
⚠️ agent 处理出错：DeepSeek Messages stream: tool input is invalid JSON
```

同一次工具调用有时成功、有时失败，重试往往就好，所以不是某个固定工具的固定失败。

## 报错出处

`@deepseek-ai/dsh-llm-deepseek/lib/index.js`，`translate()` 收尾阶段：

```js
if (reason.kind !== "max-tokens") for (const { content } of blocks.values()) {
    if (content.type !== "tool-call") continue;
    let parsed;
    try {
        parsed = JSON.parse(content.arguments);
    } catch (_invalidProviderToolJson) {
        return malformed("tool input is invalid JSON");   // ← 这里
    }
    object(parsed);
}
```

`malformed()` 的文案模板是 `` `DeepSeek Messages stream: ${detail}` ``，与现象完全一致，
所以可以确定就是这个校验在抛（`MALFORMED_RESPONSE`）。

## 根因

同一个文件里三处逻辑互相矛盾，导致 `content.arguments` 可能既不等于起始 input、
也不等于完整增量，而是"只有增量"或"重复拼接"：

### 1. 起始块已经序列化保存了 input

```js
case "tool_use":
    content = {
        type: "tool-call",
        id: ToolCallId(string(native.id)),
        name: string(native.name),
        arguments: JSON.stringify(object(native.input))   // ← 起始 input 存进 arguments
    };
    // ...
    return { index, content, replay, closed: false, json: "" };  // 累加器 json 从空串开始
```

### 2. 增量是无条件累加，不做任何判断

```js
if (delta.type === "input_json_delta" && content.type === "tool-call") {
    const argumentsDelta = string(delta.partial_json);
    block.json += argumentsDelta;    // ← 只拼接，不区分"增量式"还是"累计式"
    return { type: "tool-call-delta", index: block.index, id: content.id, argumentsDelta };
}
```

### 3. 收尾时直接用累加值覆盖，起始 input 被丢弃

```js
} else {
    block.closed = true;
    if (block.content.type === "tool-call" && block.json.length > 0)
        block.content.arguments = block.json;   // ← 无条件覆盖
}
```

**三种触发场景**：

| # | 场景 | 结果 |
|---|---|---|
| A | `content_block_start` 给了完整 `input`，同时又发 `input_json_delta` | 起始 input 被丢弃，`arguments` 只剩增量 → JSON 不完整 |
| B | `input_json_delta` 是**累计式**（每片重复前面内容）而非增量式 | `block.json` 变成重复拼接 → 非法 JSON |
| C | 同一次响应多个 tool-call，碎片落到同一 block | 两个 JSON 叠在一起 → 非法 JSON |

另外 `if (reason.kind !== "max-tokens")` 这个守卫解释了**为什么它是间歇性的**：
被 max-tokens 截断的响应会跳过该校验，所以只有"未被截断但拼接结果非法"时才暴露。

## 建议修复

判断权应该交给"哪一个真的能解析"，而不是看 `json` 是否非空：

```js
} else {
    block.closed = true;
    if (block.content.type === "tool-call" && block.json.length > 0) {
        // 起始 content_block 里可能已经带了完整 input；input_json_delta 既可能是增量式，
        // 也可能是累计式，甚至与起始 input 重复。只有在增量确实能解析时才采用它，
        // 否则保留 startBlock 里序列化好的 native.input。
        let usable = false;
        try {
            JSON.parse(block.json);
            usable = true;
        } catch {
            // 增量不可解析 —— 退回起始 input（它由 JSON.stringify 产出，必然合法）
        }
        if (usable) block.content.arguments = block.json;
    }
}
```

这样三种场景都能兜住，且失败时退回到 `JSON.stringify(native.input)` 这个**必然合法**的值，
不会再抛 `tool input is invalid JSON`。

（如果上游确实可能给出"累计式" delta，也可以再加一层判断：当 `block.json` 解析失败、
但"起始 input + 本次 delta"能解析时采用后者。上面的最小修复已能消除报错。）

## 一个放大因素（可选修）

本次现场里入参最大的是 `messages: z.union([z.string(), z.array(z.string())])` 这类
**字符串/数组联合类型**参数。联合类型会诱使模型把数组序列化成 JSON 字符串再转义一层
（`"[{\"a\":1}]"`），使工具入参规模和不合法性都上升 —— 这会**提高**命中上述缺陷的概率，
但不是缺陷本身。我在本地把该参数拆成了两个单一类型参数（`message: string` /
`messages: string[]`），作为缓解；根因仍在适配器。
