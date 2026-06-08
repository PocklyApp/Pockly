# Pockly 使用指南

<!-- Generated from web/src/content/docs.ts (the former in-app guide). Edit here; keep in sync with product behavior. -->

## Pockly 是什么？

Pockly 是运行在你电脑上的编码 agent 的远程控制台。Claude Code 和 Codex 始终在本地运行——在你的机器上，使用你的文件和你的 API key——Pockly 把每个会话镜像到手机上，让你随时查看 agent 在做什么、在运行中介入、批准工具操作、停止或重定向——这一切都在手机上完成，无需守在电脑前。

### 三个组成部分

- **守护进程（你的电脑）** — 你只需安装一次的小型后台程序。它监视本地的 Claude Code / Codex 会话，并与 Pockly Nexus 保持一条出站连接，不暴露任何入站端口。
- **Pockly Nexus（连接层）** — 消息中枢。它在你的电脑和手机之间转发会话事件，并提供 Web 应用。它从不接触你的模型 API key。
- **Web 应用（手机或任意浏览器）** — 一个移动优先的 Web 应用，在浏览器中打开或添加到主屏幕。你在这里查看和操控。

### 一条消息如何流转

当你从手机发送一条 prompt 时，路径是 Web → Pockly Nexus → 你电脑上的守护进程 → agent。agent 的输出（文本、思考、工具调用、文件改动、测试结果）沿同样的路径流回，并在手机上实时渲染。

> Pockly 同时支持 Claude Code 和 Codex。agent 始终在你的机器上运行——Pockly 绝不会把运行环境或密钥搬到云端。

## 开始之前

- 一台运行 macOS、Linux 或 Windows 的电脑，且已安装并登录 Claude Code 和/或 Codex。
- 你 agent 自己的凭证（例如 Anthropic 或 OpenAI 登录）。Pockly 使用 agent 已有的凭证——你无需在 Pockly 中输入任何 key。
- 一部带现代浏览器的手机（或任意设备）：Safari 16.4+、Chrome 或 Firefox。
- 电脑需保持唤醒且守护进程在运行。如果机器休眠或守护进程停止，会话会变为只读，直到它恢复。

## 1 · 安装守护进程

Pockly 以单个二进制文件分发。选择对应你操作系统的命令并运行——安装程序会下载守护进程、安装一个开机自启且崩溃后自动重启的后台服务，然后打开浏览器完成设置。

### macOS / Linux

```bash
curl -fsSL https://your-nexus.example/install.sh | bash
```

### Windows（PowerShell）

```bash
irm https://your-nexus.example/install.ps1 | iex
```

### 安装了什么

- **macOS** — 一个 LaunchAgent（com.pockly.daemon），登录时启动并保持存活。日志写入 ~/Library/Logs/pockly-daemon.log。
- **Linux** — 一个 systemd 用户服务（pockly-daemon.service），Restart=always，随你的用户会话启动。
- **Windows** — 一个计划任务（PocklyDaemon），登录时运行，且无运行时长限制，因此会持续运行。

> 每台电脑只需安装一次。之后每次登录守护进程都会自动恢复运行。

## 2 · 连接这台电脑

连接会把这台电脑关联到你的 Pockly 账号。它在电脑本机的浏览器中完成——这一步不涉及手机配对。

1. 安装程序会在默认浏览器中打开你的 Pockly Web 应用。
2. 登录（或创建）你的 Pockly 账号。
3. 确认“连接这台电脑？”并授权。Pockly 就在电脑本机把守护进程绑定到你的账号。
4. 守护进程连接到 Pockly Nexus，成功页会显示一个用于在手机上加入的二维码。

### 无头机或 SSH 机器

如果机器没有浏览器（例如通过 SSH 连接的服务器），setup 还会在终端打印一个授权 URL、一个简短的用户码和一个二维码。在终端确认请求后，守护进程会以相同方式完成连接。

你可以随时重新运行 setup：

```bash
pockly-daemon setup
```

## 3 · 在手机上打开 Pockly

1. 扫描 setup 完成后显示的二维码（或在工作区打开“已连接电脑”，点“添加手机”生成一个新的）。
2. 该链接会在手机上打开工作区并加入你的账号——无需输入密码。二维码是一次性的、短时有效。
3. 把 Pockly 添加到主屏幕，这样它会全屏启动，并能在关闭时也显示通知。

> 手机二维码只会创建一个 Web 登录会话——它永远不会发放守护进程令牌，因此扫码不会连接一台新电脑。

## 工作区

工作区是一个单一界面，始终保留一个头部（哪台电脑、在线状态）和一个 composer（输入栏）。你选择一个对话来接管它；中间的内容区会切换，但你始终不会离开工作区。

对话按电脑和项目分组——Pockly 根据 agent 的工作目录推断项目，因此来自不同仓库的会话彼此分开、不会混在一起。

- 活跃会话显示绿色“运行中”标记；最近的会话显示上次运行的时间。
- 打开一个对话即可查看完整时间线，并从 composer 继续它。
- 时间线顶部的“加载更早的上下文”会按需分页加载更早的历史。

## 观察一次运行

agent 的终端会实时镜像到手机上。在 agent 工作时，你能准确看到它做了什么：

- **工具调用** — 每个 Read、Edit、Write、Grep、Bash、网络抓取或子任务都渲染为独立卡片，并带状态徽章（如完成、命中数、+新增 −删除）。
- **思考过程** — 扩展推理会折叠进一个可展开的区块，需要细节时再展开。
- **代码与 diff** — 文件读取和编辑会带语法高亮。composer 上方的 Diffs 药丸会打开一个抽屉，汇总本次运行改动的每个文件，并提供逐文件的统一 diff。

## 运行中介入

在 composer 中输入并发送，即可把一条 prompt 插入已经在运行的会话——纠正一次重构、补充一个约束，或排上下一个任务。如果 agent 正处于某一轮中，你的消息会被排队，在安全时立即送达，因此不会打断它的循环。

当 agent 正在流式输出时，发送按钮会变成停止控件——点一下即可中止当前这一轮。

### 什么时候可以介入？

一个对话是否可写，取决于 Pockly 当前与它的连接方式：

- **已连接到终端** — 你电脑上有一个被包裹的终端会话在运行。手机和终端互为镜像——两边都能输入。
- **无头续跑** — 没有连接终端，但守护进程在线。你发出第一条消息时，Pockly 会在电脑上以无头方式续跑该会话并把结果流回。这是常见的纯手机场景。
- **只读** — 电脑离线，或对话位于另一台电脑上。你可以阅读历史，但在那台电脑恢复在线前无法发送。

## 批准工具操作

当 agent 想执行需要你批准的操作时，composer 上方会出现一张权限卡片，显示具体的命令或操作。直接在手机上点“允许”或“拒绝”。

> Pockly 只负责转发提示和你的决定。agent（Claude Code / Codex）仍然掌握权限决策并自行执行命令——Pockly 绝不会在你的机器上执行任何东西。

被询问的频率取决于“运行配置”中的权限模式（见下文）。

## 运行配置

composer 中的“运行配置”药丸会打开一个含三项控制的面板。它们作用于你当前所在的对话，并会为下一条消息记住设置。

- **模型** — agent 下一轮使用的模型。可选项来自你的 agent 和配置。
- **思考深度** — agent 投入多少推理预算：default、low、medium、high、xhigh 或 max。
- **权限模式** — Ask permissions（每次操作都询问）、Accept edits（自动批准文件编辑）、Plan mode（先规划、不执行），或 Auto mode。

> 可用权限模式来自已连接的 agent 和运行时。Pockly 只转发你选择的原生模式，不创建另一套审批策略。

## 多台电脑

一个账号最多可连接 8 台电脑——工作笔记本、家用主机、开发 VM。每台都保留自己的会话列表，互不混淆。在工作区头部的电脑菜单中切换，对话列表会更新为那台电脑的内容。

## 通知

在“设置”中开启浏览器通知，当一次运行需要你时就会收到提醒——通常是任务完成、运行失败，或 agent 在等待权限决定时。通知通过 Web Push 送达，因此即使应用关闭也能收到（添加到主屏幕后效果最好）。

Web Push 在 iOS Safari 16.4+ 和 Android Chrome 上可用。Pockly 只发送一个轻量摘要；完整对话会在你打开应用时加载。

## 安全与隐私

- 你的 agent 运行环境和 API key 绝不离开你的电脑。Pockly Nexus 从不接触它们——只转发会话事件。
- 传输全程由 TLS 保护（HTTPS / 安全 WebSocket）。
- 会话历史存储在 Nexus 上，方便你在任意已登录浏览器中接续对话。
- 每个浏览器都会保存自己的本地访问密钥。用“将此浏览器登出”移除单个浏览器的访问；在“已连接电脑”中吊销一台电脑以彻底切断那台电脑。

> Pockly 绝不会要求你把密码、API key 或银行卡信息输入到 agent 里。这些只保留在你的 agent 和电脑上。

## 故障排查

- **“这台电脑已离线”** — 守护进程未能连上 Pockly Nexus。它本应自动运行，你可以在电脑上用下面的 status 命令检查，然后刷新页面。
- **“仍在连接”** — 守护进程正在连接 Pockly Nexus——稍等几秒。完全在线后会话即可写入。
- **无法加载对话 / 访问未就绪** — 此浏览器尚未获授权。请在此浏览器重新登录，或在已有访问权限的浏览器中打开 Pockly。
- **对话处于只读状态** — 电脑离线，或对话位于另一台电脑上。让那台电脑重新上线即可再次操控。

### 检查守护进程

```bash
pockly-daemon status
```

### 更新守护进程

```bash
pockly-daemon update
```

## 守护进程命令参考

你很少需要这些——守护进程会自行在后台运行——但当需要手动干预时它们很有用。

- **pockly-daemon setup** — 连接这台电脑并（重新）安装后台服务。
- **pockly-daemon serve** — 在前台运行守护进程（监视会话、连接 Pockly Nexus）。
- **pockly-daemon login** — 把这个守护进程登录到一个 Pockly 账号。
- **pockly-daemon status** — 打印守护进程健康状态。
- **pockly-daemon update** — 检查并安装更新版守护进程（别名：upgrade）。
- **pockly-daemon remote** — 为同账号手机连接开启或关闭远程访问。

## 卸载

停止并移除后台服务，然后删除二进制文件。具体步骤取决于你的操作系统：

### macOS

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.pockly.daemon.plist
rm ~/Library/LaunchAgents/com.pockly.daemon.plist
```

### Linux

```bash
systemctl --user disable --now pockly-daemon.service
rm ~/.config/systemd/user/pockly-daemon.service
```

### Windows (PowerShell)

```bash
schtasks /Delete /TN PocklyDaemon /F
```

随后删除守护进程二进制文件；如果想立即切断它的访问，在工作区的“已连接电脑”中吊销这台电脑。


