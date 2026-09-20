# MCP

MCP（Model Context Protocol）是一个开放协议，让 AI 接入外部服务。在 YOLO 里它是双向的：

- **接入别人** —— 让 YOLO 用上 GitHub、数据库、搜索服务等外部工具
- **被别人接入** —— 让 Claude Desktop 等外部客户端反过来使用你的库

> **MCP 仅桌面端可用。** 不只是本地进程类型，远程的 HTTP / SSE / WebSocket 在移动端也一并禁用。移动端设置里会直接提示「移动设备不支持自定义工具（MCP）」。

## 接入外部 MCP 服务

入口：**设置 → Agent → 全局能力 → 工具 → 「管理工具」**，弹窗底部是 MCP 服务器管理，点「**添加 MCP 服务器**」。

表单支持**表单模式**和 **JSON 模式**两种编辑方式，可以互相切换。

### 支持的连接方式

| 类型 | 值 | 说明 |
|------|-----|------|
| 本地进程 | `stdio` | 在你机器上起一个子进程 |
| 远程 | `http` | Streamable HTTP，支持 OAuth 或自定义请求头 |
| 远程 | `sse` | Server-Sent Events |
| 远程 | `ws` | WebSocket |

### 配置示例

本地进程（以 GitHub 官方 MCP 为例）：

```json
{
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "你的 token"
  }
}
```

远程 HTTP，用请求头鉴权：

```json
{
  "transport": "http",
  "url": "https://example.com/mcp",
  "headers": {
    "Authorization": "Bearer 你的 token"
  }
}
```

**也兼容 Claude Desktop 的配置格式**，直接粘贴进 JSON 编辑框即可，会自动识别：

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "你的 token" }
    }
  }
}
```

如果 `mcpServers` 里有多个服务器，需要在「名称」字段指定要导入哪一个。只有一个时名称会自动填好。

### OAuth

只有 `http` 类型支持。在认证方式里选 OAuth，点「Connect」，YOLO 会打开系统浏览器完成授权。弹窗里会显示状态（检查中 / 连接中 / 已连接 / 失败），**连接成功后才允许保存**。

之后重命名这个服务器时，已保存的凭据会自动迁移，不用重新授权。

### 连上之后

服务器列表里每行显示名称、状态、发现到的工具数量，以及启用开关。

每个 Agent 还能在自己的**工具**标签里单独控制这个服务器：

- **披露模式**：「按需披露」只在提示词里放工具名，用到时才加载完整定义；「常驻上下文」每轮都带完整定义。**工具多的服务器建议选按需披露**
- **审批模式**：完全放行 / 需要审批 / 危险操作审批

### 两个成本提醒

**Token 成本**：MCP 工具返回的结果会整体进入模型上下文。返回内容大的服务（比如一次拉几百条记录的数据库查询）会显著推高消耗。添加弹窗顶部就有这条提示。

**安全边界**：MCP 工具跑在外部进程里，**不经过 YOLO 的路径检查**。这意味着一个有文件访问能力的 MCP 服务器可以绕过[工作区范围](./tools-and-permissions.md#工作区范围限制它能自主翻到哪)限制。只接入你信任的服务。

## 把 YOLO 提供给外部 Agent

反过来，你可以让 Claude Desktop、其他 MCP 客户端使用你的库。

入口：**设置 → Agent → 外部 Agent 接入**（**仅桌面端**）。

打开「允许外部 Agent 访问」后，YOLO 会在本机起一个 HTTP MCP 服务，默认端口 **28124**（刻意避开 Local REST API 插件常用的 27123/27124）。

界面上会直接给出可以粘贴到客户端的连接配置：

```json
{
  "transport": "http",
  "url": "http://127.0.0.1:28124/mcp",
  "headers": {
    "Authorization": "Bearer <自动生成的 token>"
  }
}
```

### 对外暴露什么

四个工具：

| 工具 | 作用 |
|------|------|
| `vault_search` | 检索你的库 |
| `agent_task_start` | 指定一个已配置的 YOLO Agent 加一段指令，**异步**派发任务，立刻返回任务 ID |
| `agent_task_get` | 查任务状态和结果 |
| `agent_task_cancel` | 取消任务 |

也就是说外部 Agent 不只能搜你的笔记，还能**借用你配好的 YOLO Agent 去干活**。

任务最多四个并发，状态流转是：运行中 → （可能）等待用户确认 → 完成 / 失败 / 取消 / 中断。

> 「等待用户确认」是指任务触发了需要审批的工具。这时你要回到 Obsidian 里处理，任务才会继续。

**任务本质上就是在后台新建了一条普通对话**，跑完之后你可以在 Obsidian 的对话历史里正常打开它，看完整记录——不是黑盒执行。

### 端口和 token

端口冲突时会给出针对性提示（最常见是和 Local REST API 之类的插件撞了），改个端口即可。

Token 只在**首次开启时自动生成**，界面上没有单独的"重新生成"按钮。如果你需要换一个（比如 token 泄露了），把开关关掉再打开一次。

## 关于定时任务

**YOLO 没有内置的定时任务或 cron 功能。**

上面的外部接入提供的是"外部系统按需触发的异步后台任务"，不是定时触发。如果你想要真正的定时能力，需要靠外部工具（系统的 cron、或者客户端自己的调度能力）来定时调用这个接口。

---

## 相关

- 工具权限和审批：[工具与权限](./tools-and-permissions.md)
- 按 Agent 配置 MCP 偏好：[Agent 与子 Agent](./assistants.md)
- 不需要外部服务的本地能力扩展：[Skills](./skills.md)
