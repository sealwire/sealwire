<p align="center">
  <img src="docs/images/logo.png" width="64" height="64" alt="sealwire logo">
</p>

<h1 align="center">Sealwire</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/sealwire">
    <img src="https://img.shields.io/npm/v/sealwire?style=flat&logo=npm" alt="npm version">
  </a>
  <a href="https://github.com/sealwire/sealwire/stargazers">
    <img src="https://img.shields.io/github/stars/sealwire/sealwire?style=flat&logo=github" alt="GitHub stars">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-Elastic--2.0-555" alt="License">
  </a>
</p>

<p align="center">
  <a href="./README.md">English</a> · <strong>中文</strong>
</p>

<p align="center">你的编程智能体，在本机协同工作 —— 出门在外，也能揣在口袋里。</p>

<p align="center">
  <img src="docs/images/desktop-home.png" alt="桌面上的 Sealwire：侧边栏和标签页里是 Claude Code、Codex 与 Cursor 会话，中间是对话，以及它改动的具体代码行" width="100%">
</p>

Sealwire 把 Claude Code、Codex 和 Cursor 收进同一个简洁界面。在书桌前开工，用手机盯进度，在沙发上批准下一步。智能体跑在你自己的电脑上、紧挨着你的代码 —— Sealwire 本身看不到那些内容。

- **所有智能体，一处搞定。** Claude Code、Codex、Cursor 并排出现在同一窗口、同一套操作里。每个任务用你顺手的那个，项目做到一半也能切换。
- **互相检查对方的活。** 让*另一个*智能体来审刚写完的东西 —— Claude 审 Codex，Codex 审 Claude —— 来回对打，直到审阅方满意为止。
- **像团队一样干活。** 设一个目标让智能体自己跑完，把支线交给另一个，或把整件事交接出去 —— 每一步都是一条斜杠命令。
- **走到哪，接到哪。** 同一会话跟着你从笔记本到浏览器到手机。智能体需要你时会通知你，当场就能批准。
- **默认私密。** Sealwire 不存你的代码，也不存你的对话。手机从外网连进来时，全程端到端加密 —— 中间的服务器也读不懂。
- **本机免费。** 不用注册、不用部署 —— 一条命令就能跑起来。用手机远程访问要走 SealWire Cloud，需要一把 access key。

## 开始使用

至少装好并登录下面之一：

- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** — Claude 登录，或设置 `ANTHROPIC_API_KEY`。其余依赖都已打进包里。
- **[Codex](https://github.com/openai/codex)** — 命令行工具 `codex`。
- **[Cursor](https://cursor.com/cli)** — 命令行工具 `cursor-agent`。

然后，进入你要干活的目录：

```bash
npx sealwire
```

Sealwire 会在浏览器打开 <http://localhost:8787>。在你另作决定之前，它只监听本机。

**小提示：** 放在一台常开的机器上跑 —— 台式机、家里的小服务器 —— 合上笔记本，长任务照样继续。

### 连上手机

```bash
npx sealwire cloud
```

第一次会要你的 SealWire Cloud access key。用手机扫二维码，同样的会话就会出现在手机上。加到主屏幕，用起来就像 App，通知也有。

## 让智能体互相审阅

同一个模型自己改自己的作业，算不上真正的检查。在 Sealwire 里，审阅一键搞定：选谁来审、用哪个模型、允许多少轮来回。

<p align="center">
  <img src="docs/images/desktop-review-dialog.png" alt="「请求审阅」对话框：选择审阅智能体、模型、说明和轮数" width="100%">
</p>

审阅方在自己的会话里工作，看的是真实改动，再把发现 —— 以及明确结论 —— 发回你的对话。允许多轮时，两边会一直对打到审阅方通过为止。

<p align="center">
  <img src="docs/images/desktop-review-result.png" alt="Codex 的审阅结果发回对话；旁边是 Agents 面板，显示目标、三轮审阅，以及交给其他智能体的问题" width="100%">
</p>

## 四条挑大梁的命令

在输入框里敲 `/`。每条命令会读你写的自然语言参数 —— 比如谁、哪个模型、多认真 —— `codex`、`opus 5`、`high` —— 后面跟的就是具体指示。

<p align="center">
  <img src="docs/images/desktop-slash-commands.png" alt="输入 / 打开菜单：上面是 Sealwire 的 /review、/goal、/delegate、/handover，下面是本项目的 Claude Code skills" width="100%">
</p>

| 命令 | 作用 |
|---|---|
| `/goal` | 给智能体一条终点线，让它自己往前跑，直到抵达。它只会停下来告诉你*干完了*（带证据）、*卡住了*（以及原因），或*需要你拍板*。 |
| `/review` | 让另一个智能体检查目前的成果。例如：`/review codex high focus on the error paths` |
| `/delegate` | 把支线活交给另一个智能体，等它把答案带回来 —— 比如 Codex 去追 flaky 测试，Claude 继续主线。两边对话都开着，你可以旁观，也可以插手。 |
| `/handover` | 当前智能体写清现状，把整件事交给另一个收尾。配额用尽、或想换双新鲜眼睛时很有用。 |

`/delegate` 和 `/handover` 里也可以敲 `@`，选一个已经开着的会话，而不必新开一个。各智能体自己的命令和 skills 会出现在同一菜单里，就在这些命令旁边。

## 人在哪里，控制就在哪里

长任务不该把你钉在书桌前。每个会话都在手机上 —— 谁在干什么、哪个目标还在跑、跑到哪了、你拉进来的那些智能体带回了什么。

<p align="center">
  <img src="docs/images/phone-sessions.png" alt="手机上的 Sealwire：会话列表，Claude Code、Codex、Cursor 会话并排显示" width="320">
  &nbsp;&nbsp;
  <img src="docs/images/phone-goal.png" alt="手机上的 Sealwire：Agents 面板，目标进行到第 3 / 20 轮，以及 Codex 已回答的问题" width="320">
</p>

智能体要跑命令或改动重要东西时，你会看到它具体在求什么，当场批准或拒绝。推送会告诉你某个会话需要你、做完了、或出了状况；**Take over** 则把控制权接到手里这台设备上。

## 还有不少

- **项目与 worktree** —— 会话按仓库和分支分组，面板里精确显示改了什么。
- **标签与钉选** —— 多个会话并排开着。
- **从任意消息分叉对话**，换条思路试试，又不丢原文 —— 甚至可以分到另一个文件夹。
- **跨会话搜索和通知铃**，后台需要你的智能体不会丢。
- **按会话设置批准模式**，从「什么都问我」到「直接干」。
- **macOS 桌面应用**（预览），带菜单栏图标。

## 命令

```bash
npx sealwire                 # 只在本机启动，并打开浏览器
npx sealwire cloud           # 同时允许手机从任意地点连入（需要 access key）
npx sealwire local           # 保证它绝不连互联网
npx sealwire --port 8788     # 换一个端口
npx sealwire --no-open       # 不要打开浏览器
npx sealwire --help          # 其余全部选项
```

想自己搭连接服务器、不用 Sealwire Cloud？把 `--broker` 指到自建实例即可。

## 即将到来

- **Tasks 与任务团队** —— 给 Sealwire 一个目标，协调智能体做计划、拆给多个智能体，落地前再审一遍。你批准计划，其余它来。
- **用量与费用** —— 每个智能体、每个项目每周用了多少 token、花了多少钱。
- 不止 Claude Code、Codex、Cursor 的更多智能体。
- 原生移动应用 —— 网页版触到天花板的那些地方。

## 安全

默认就是私密模式：设备之间传输的内容端到端加密，连接服务器只转发它读不懂的数据。细节见 [`docs/security-model.md`](docs/security-model.md)。

## 开发

Sealwire 是一个 Rust 服务端、一个给 Claude Code 用的小型 Node worker，以及一个 Vite Web 应用。[`AGENTS.md`](AGENTS.md) 有代码地图和改完后要跑的检查，[`docs/testing-matrix.md`](docs/testing-matrix.md) 说明各测试套件覆盖什么。

```bash
cargo test -p relay-server
node --test claude-worker/*.test.mjs
npm test
```

## 许可

以 Elastic License 2.0 源码可用。见 [`LICENSE`](LICENSE)。

## 贡献

提交贡献即表示你同意 [`CONTRIBUTING.md`](CONTRIBUTING.md) 中的条款，包括允许维护者日后重新许可贡献内容的宽泛许可。
