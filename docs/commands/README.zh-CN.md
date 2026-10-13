# 斜杠命令

[English](README.md)

在输入框里敲 `/`，Sealwire 会给出它自己的四条命令，旁边是你那些智能体自带的命令和 skills：

- [`/review`](review.zh-CN.md) —— 让另一个智能体检查目前的成果。
- [`/goal`](goal.zh-CN.md) —— 给这个会话一条终点线，让它自己一直干下去。
- [`/delegate`](delegate.zh-CN.md) —— 把一件支线活交给另一个智能体，等它把答案带回来。
- [`/handover`](handover.zh-CN.md) —— 把整件事交给另一个智能体收尾。

## 我该用哪条？

- 想让**另一个智能体看看**刚做完的东西 → `/review`。
- 想让**这个智能体自己一直干**，直到某件事做完 → `/goal`。
- 想让**另一个智能体干其中一块**，这边接着干，答案送回这里 → `/delegate`。
- 想让**另一个智能体接手**，这边不干了 → `/handover`。

## 它们的区别

| | `/review` | `/goal` | `/delegate` | `/handover` |
|---|---|---|---|---|
| 谁来干活 | 另一个智能体，只读 | 当前会话 | 另一个智能体 | 另一个智能体 |
| 什么会回到这里 | 审阅意见和结论 | 干完了、卡住了，或一个要你回答的问题 | 另一个智能体的答案 | 什么都不回来——单向的 |
| 默认找谁 | 换一家 provider | —— | 换一家 provider | 同一家 provider |
| 能指定 provider、模型、思考强度 | 能 | 不能 | 能 | 能 |
| 能用 `@` 选已有会话 | 能，限这个对话以前用过的审阅方 | 不能 | 能 | 能 |
| 需要 Full access (YOLO) | 不需要 | 需要 | 不需要 | 不需要 |
| 智能体能不能自己发起（MCP） | 暂时不能 | 不能 | 能 | 不能 |

谁来干、怎么干，直接用普通的词写：`codex`、`claude`、`gpt-5.5`、`opus 5`、`high`。模型就写模型菜单里显示的名字。这些词后面写的就是具体指示。一个词如果认不准是哪个 provider、模型或思考强度，就留在指示里原样不动——Sealwire 不会去猜。

## MCP：智能体自己能做什么

每个普通会话——Claude Code、Codex、Cursor、OpenCode、Pi——都会通过 MCP 拿到一小组 Sealwire 工具，在智能体的工具列表里显示为 `sealwire-…`。智能体就是靠这些工具参与这几条命令的，不用你敲任何东西：

| 工具 | 做什么 | 谁能用 |
|---|---|---|
| `delegate` | 找另一个智能体干一件事，和 `/delegate` 一样 | Full access (YOLO) 的会话 |
| `report_back` | 把答案交回给找它干活的那个智能体或人 | 所有普通会话，权限受限的也有 |
| `goal_status`、`goal_plan`、`goal_step` | 读目标、列计划、勾掉做完的步骤 | Full access (YOLO) 的会话 |
| `goal_complete`、`goal_blocked`、`goal_needs_you` | 结束一个目标只有这三种方式：干完了、卡住了、要问你 | Full access (YOLO) 的会话 |

故意没有的：

- **没有设定或修改目标的工具。** 只有你能用 `/goal` 设。智能体要是能改自己的目标，就会把它改成一个自己做得完的。
- **暂时没有审阅工具。** 智能体不能自己发起审阅，要你用 `/review` 或 **Request reviewer** 按钮来发起。
- **没有交接工具。** 把整件事交出去，永远由你决定。

权限受限（不是 Full access）的会话如果去调 `delegate` 或任何 `goal_*` 工具，会被拒绝，并被告知去请你来做。审阅方的会话拿不到任何 Sealwire 工具。
