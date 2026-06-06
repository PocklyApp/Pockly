/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pockly documentation content.
 *
 * Long-form, user-facing docs live here (not in the i18n UI-string files) so
 * the prose stays readable and maintainable. Each string is authored in both
 * English and Simplified Chinese inline via `tr(en, zh)`. The DocsPage renders
 * the returned block list. Content is grounded in the real product behavior
 * (daemon install / local-setup flow / connection modes / run config /
 * security model) — keep it in sync with the code, not with marketing copy.
 */

export type DocsBlock =
  | { kind: "p"; text: string }
  | { kind: "subhead"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "steps"; items: string[] }
  | { kind: "command"; code: string; caption?: string }
  | { kind: "note"; text: string }
  | { kind: "defs"; items: Array<{ term: string; desc: string }> };

export type DocsSection = {
  id: string;
  title: string;
  blocks: DocsBlock[];
};

export function getDocsSections(lang: string): DocsSection[] {
  const zh = lang === "zh-CN";
  const tr = (en: string, cn: string) => (zh ? cn : en);

  return [
    // ───────────────────────────────────────────────────────────── Overview
    {
      id: "overview",
      title: tr("What is Pockly?", "Pockly 是什么？"),
      blocks: [
        {
          kind: "p",
          text: tr(
            "Pockly is a remote control for the coding agents that run on your computer. Claude Code and Codex keep running locally — on your machine, with your files and your API keys — and Pockly mirrors each session to your phone so you can watch what the agent is doing, steer it mid-run, approve tool actions, and stop or redirect it, all from your phone without having to be at your computer.",
            "Pockly 是运行在你电脑上的编码 agent 的远程控制台。Claude Code 和 Codex 始终在本地运行——在你的机器上，使用你的文件和你的 API key——Pockly 把每个会话镜像到手机上，让你随时查看 agent 在做什么、在运行中介入、批准工具操作、停止或重定向——这一切都在手机上完成，无需守在电脑前。"
          ),
        },
        { kind: "subhead", text: tr("The three pieces", "三个组成部分") },
        {
          kind: "defs",
          items: [
            {
              term: tr("Daemon (your computer)", "守护进程（你的电脑）"),
              desc: tr(
                "A small background program you install once. It watches your local Claude Code / Codex sessions and keeps an outbound connection to the relay. Nothing inbound is exposed.",
                "你只需安装一次的小型后台程序。它监视本地的 Claude Code / Codex 会话，并与 relay 保持一条出站连接，不暴露任何入站端口。"
              ),
            },
            {
              term: tr("Relay (the cloud, pocklyapp.com)", "Relay（云端，pocklyapp.com）"),
              desc: tr(
                "The message hub. It forwards session events between your computer and your phone, and serves the web app. It never sees your model API keys.",
                "消息中枢。它在你的电脑和手机之间转发会话事件，并提供 Web 应用。它从不接触你的模型 API key。"
              ),
            },
            {
              term: tr("Web app (your phone or any browser)", "Web 应用（手机或任意浏览器）"),
              desc: tr(
                "A mobile-first web app you open in a browser or add to your home screen. This is where you watch and steer.",
                "一个移动优先的 Web 应用，在浏览器中打开或添加到主屏幕。你在这里查看和操控。"
              ),
            },
          ],
        },
        { kind: "subhead", text: tr("How a message travels", "一条消息如何流转") },
        {
          kind: "p",
          text: tr(
            "When you send a prompt from your phone, it goes web → relay → your computer's daemon → the agent. The agent's output (text, thinking, tool calls, file edits, test results) streams back the same way and renders live on your phone.",
            "当你从手机发送一条 prompt 时，路径是 Web → relay → 你电脑上的守护进程 → agent。agent 的输出（文本、思考、工具调用、文件改动、测试结果）沿同样的路径流回，并在手机上实时渲染。"
          ),
        },
        {
          kind: "note",
          text: tr(
            "Pockly supports both Claude Code and Codex. The agent always runs on your machine — Pockly never moves your runtime or keys to the cloud.",
            "Pockly 同时支持 Claude Code 和 Codex。agent 始终在你的机器上运行——Pockly 绝不会把运行环境或密钥搬到云端。"
          ),
        },
      ],
    },

    // ─────────────────────────────────────────────────────── Requirements
    {
      id: "requirements",
      title: tr("Before you start", "开始之前"),
      blocks: [
        {
          kind: "list",
          items: [
            tr(
              "A computer running macOS, Linux, or Windows with Claude Code and/or Codex already installed and signed in.",
              "一台运行 macOS、Linux 或 Windows 的电脑，且已安装并登录 Claude Code 和/或 Codex。"
            ),
            tr(
              "Your agent's own credentials (e.g. your Anthropic or OpenAI auth). Pockly uses whatever the agent already uses — you don't enter any keys into Pockly.",
              "你 agent 自己的凭证（例如 Anthropic 或 OpenAI 登录）。Pockly 使用 agent 已有的凭证——你无需在 Pockly 中输入任何 key。"
            ),
            tr(
              "A phone (or any device) with a modern browser: Safari 16.4+, Chrome, or Firefox.",
              "一部带现代浏览器的手机（或任意设备）：Safari 16.4+、Chrome 或 Firefox。"
            ),
            tr(
              "The computer stays awake with the daemon running. If the machine sleeps or the daemon stops, sessions become read-only until it's back.",
              "电脑需保持唤醒且守护进程在运行。如果机器休眠或守护进程停止，会话会变为只读，直到它恢复。"
            ),
          ],
        },
      ],
    },

    // ──────────────────────────────────────────────────────────── Install
    {
      id: "install",
      title: tr("1 · Install the daemon", "1 · 安装守护进程"),
      blocks: [
        {
          kind: "p",
          text: tr(
            "Pockly ships as a single binary. Pick the line for your operating system and run it — the installer downloads the daemon, installs a background service that starts on login and restarts itself if it stops, then opens your browser to finish setup.",
            "Pockly 以单个二进制文件分发。选择对应你操作系统的命令并运行——安装程序会下载守护进程、安装一个开机自启且崩溃后自动重启的后台服务，然后打开浏览器完成设置。"
          ),
        },
        { kind: "subhead", text: tr("macOS / Linux", "macOS / Linux") },
        { kind: "command", code: "curl -fsSL https://cdn.pocklyapp.com/install.sh | bash" },
        { kind: "subhead", text: tr("Windows (PowerShell)", "Windows（PowerShell）") },
        { kind: "command", code: "irm https://cdn.pocklyapp.com/install.ps1 | iex" },
        { kind: "subhead", text: tr("What gets installed", "安装了什么") },
        {
          kind: "defs",
          items: [
            {
              term: "macOS",
              desc: tr(
                "A LaunchAgent (com.pockly.daemon) that runs at login and is kept alive. Logs go to ~/Library/Logs/pockly-daemon.log.",
                "一个 LaunchAgent（com.pockly.daemon），登录时启动并保持存活。日志写入 ~/Library/Logs/pockly-daemon.log。"
              ),
            },
            {
              term: "Linux",
              desc: tr(
                "A systemd user service (pockly-daemon.service) with Restart=always, started for your user session.",
                "一个 systemd 用户服务（pockly-daemon.service），Restart=always，随你的用户会话启动。"
              ),
            },
            {
              term: "Windows",
              desc: tr(
                "A Scheduled Task (PocklyDaemon) that runs at logon, with no run-time limit so it stays up.",
                "一个计划任务（PocklyDaemon），登录时运行，且无运行时长限制，因此会持续运行。"
              ),
            },
          ],
        },
        {
          kind: "note",
          text: tr(
            "You only install once per computer. After that the daemon comes back on its own every time you log in.",
            "每台电脑只需安装一次。之后每次登录守护进程都会自动恢复运行。"
          ),
        },
      ],
    },

    // ──────────────────────────────────────────── Connect this computer
    {
      id: "connect-computer",
      title: tr("2 · Connect this computer", "2 · 连接这台电脑"),
      blocks: [
        {
          kind: "p",
          text: tr(
            "Connecting links this computer to your Pockly account. It happens in the browser on the computer itself — there's no phone pairing for this step.",
            "连接会把这台电脑关联到你的 Pockly 账号。它在电脑本机的浏览器中完成——这一步不涉及手机配对。"
          ),
        },
        {
          kind: "steps",
          items: [
            tr(
              "The installer opens pocklyapp.com in your default browser.",
              "安装程序会在默认浏览器中打开 pocklyapp.com。"
            ),
            tr(
              "Sign in to (or create) your Pockly account.",
              "登录（或创建）你的 Pockly 账号。"
            ),
            tr(
              "Confirm \"Connect this computer?\" and authorize. Pockly binds the daemon to your account right there on the computer.",
              "确认“连接这台电脑？”并授权。Pockly 就在电脑本机把守护进程绑定到你的账号。"
            ),
            tr(
              "The daemon connects to the relay and a success page shows a QR code for joining on your phone.",
              "守护进程连接到 relay，成功页会显示一个用于在手机上加入的二维码。"
            ),
          ],
        },
        { kind: "subhead", text: tr("Headless or SSH machines", "无头机或 SSH 机器") },
        {
          kind: "p",
          text: tr(
            "If the machine has no browser (a server over SSH, for example), the setup also prints an authorization URL, a short user code, and a QR code in the terminal. Approve the request in the terminal and the daemon is connected the same way.",
            "如果机器没有浏览器（例如通过 SSH 连接的服务器），setup 还会在终端打印一个授权 URL、一个简短的用户码和一个二维码。在终端确认请求后，守护进程会以相同方式完成连接。"
          ),
        },
        {
          kind: "p",
          text: tr(
            "You can re-run setup at any time:",
            "你可以随时重新运行 setup："
          ),
        },
        { kind: "command", code: "pockly-daemon setup" },
      ],
    },

    // ──────────────────────────────────────────────── Open on your phone
    {
      id: "open-on-phone",
      title: tr("3 · Open Pockly on your phone", "3 · 在手机上打开 Pockly"),
      blocks: [
        {
          kind: "steps",
          items: [
            tr(
              "Scan the QR code shown after setup (or open Devices in the workspace and tap \"Add a phone\" to show a fresh one).",
              "扫描 setup 完成后显示的二维码（或在工作区打开“设备”，点“添加手机”生成一个新的）。"
            ),
            tr(
              "The link opens the workspace on your phone and joins your account — no password to type. The QR is one-time and short-lived.",
              "该链接会在手机上打开工作区并加入你的账号——无需输入密码。二维码是一次性的、短时有效。"
            ),
            tr(
              "Add Pockly to your home screen so it launches fullscreen and can show notifications even when closed.",
              "把 Pockly 添加到主屏幕，这样它会全屏启动，并能在关闭时也显示通知。"
            ),
          ],
        },
        {
          kind: "note",
          text: tr(
            "The phone QR only creates a web login — it can never hand out a daemon token, so scanning it can't connect a new computer.",
            "手机二维码只会创建一个 Web 登录会话——它永远不会发放守护进程令牌，因此扫码不会连接一台新电脑。"
          ),
        },
      ],
    },

    // ───────────────────────────────────────────────────────── Workspace
    {
      id: "workspace",
      title: tr("The workspace", "工作区"),
      blocks: [
        {
          kind: "p",
          text: tr(
            "The workspace is a single screen that always keeps a header (which computer, online status) and a composer (the input bar) in place. You pick a conversation to take control of; the body in between switches without ever leaving the workspace.",
            "工作区是一个单一界面，始终保留一个头部（哪台电脑、在线状态）和一个 composer（输入栏）。你选择一个对话来接管它；中间的内容区会切换，但你始终不会离开工作区。"
          ),
        },
        {
          kind: "p",
          text: tr(
            "Conversations are grouped by computer and by project — Pockly derives the project from the agent's working directory, so sessions from different repos stay separate and don't cross-mix.",
            "对话按电脑和项目分组——Pockly 根据 agent 的工作目录推断项目，因此来自不同仓库的会话彼此分开、不会混在一起。"
          ),
        },
        {
          kind: "list",
          items: [
            tr(
              "Active sessions show a green \"live\" marker; recent ones show how long ago they ran.",
              "活跃会话显示绿色“运行中”标记；最近的会话显示上次运行的时间。"
            ),
            tr(
              "Open a conversation to see its full timeline and continue it from the composer.",
              "打开一个对话即可查看完整时间线，并从 composer 继续它。"
            ),
            tr(
              "\"Load earlier context\" at the top of the timeline pages older history in on demand.",
              "时间线顶部的“加载更早的上下文”会按需分页加载更早的历史。"
            ),
          ],
        },
      ],
    },

    // ─────────────────────────────────────────────────────── Watch a run
    {
      id: "watch",
      title: tr("Watching a run", "观察一次运行"),
      blocks: [
        {
          kind: "p",
          text: tr(
            "The agent's terminal mirrors to your phone in real time. As the agent works, you see exactly what it does:",
            "agent 的终端会实时镜像到手机上。在 agent 工作时，你能准确看到它做了什么："
          ),
        },
        {
          kind: "defs",
          items: [
            {
              term: tr("Tool calls", "工具调用"),
              desc: tr(
                "Each Read, Edit, Write, Grep, Bash, web fetch, or sub-task renders as its own card with a status badge (e.g. done, hit count, +added −removed).",
                "每个 Read、Edit、Write、Grep、Bash、网络抓取或子任务都渲染为独立卡片，并带状态徽章（如完成、命中数、+新增 −删除）。"
              ),
            },
            {
              term: tr("Thinking", "思考过程"),
              desc: tr(
                "Extended reasoning folds into a collapsible block you can expand when you want the detail.",
                "扩展推理会折叠进一个可展开的区块，需要细节时再展开。"
              ),
            },
            {
              term: tr("Code & diffs", "代码与 diff"),
              desc: tr(
                "File reads and edits are syntax-highlighted. The Diffs pill above the composer opens a drawer summarizing every file the run changed, with a per-file unified diff.",
                "文件读取和编辑会带语法高亮。composer 上方的 Diffs 药丸会打开一个抽屉，汇总本次运行改动的每个文件，并提供逐文件的统一 diff。"
              ),
            },
          ],
        },
      ],
    },

    // ──────────────────────────────────────────────────────── Steer / inject
    {
      id: "steer",
      title: tr("Steering mid-run", "运行中介入"),
      blocks: [
        {
          kind: "p",
          text: tr(
            "Type into the composer and send to slip a prompt into a session that's already running — correct a refactor, add a constraint, or line up the next task. If the agent is mid-turn, your message is queued and delivered as soon as it's safe, so you never break its loop.",
            "在 composer 中输入并发送，即可把一条 prompt 插入已经在运行的会话——纠正一次重构、补充一个约束，或排上下一个任务。如果 agent 正处于某一轮中，你的消息会被排队，在安全时立即送达，因此不会打断它的循环。"
          ),
        },
        {
          kind: "p",
          text: tr(
            "While the agent is streaming, the send button becomes a stop control — tap it to halt the current turn.",
            "当 agent 正在流式输出时，发送按钮会变成停止控件——点一下即可中止当前这一轮。"
          ),
        },
        { kind: "subhead", text: tr("When can you steer?", "什么时候可以介入？") },
        {
          kind: "p",
          text: tr(
            "Whether a conversation is writable depends on how Pockly is connected to it right now:",
            "一个对话是否可写，取决于 Pockly 当前与它的连接方式："
          ),
        },
        {
          kind: "defs",
          items: [
            {
              term: tr("Live-attached", "已连接到终端"),
              desc: tr(
                "A wrapped terminal session is running on your computer. The phone and the terminal mirror each other — both can type.",
                "你电脑上有一个被包裹的终端会话在运行。手机和终端互为镜像——两边都能输入。"
              ),
            },
            {
              term: tr("Headless resume", "无头续跑"),
              desc: tr(
                "No terminal is attached, but the daemon is online. On your first message Pockly resumes the session headlessly on the computer and streams it back. This is the common mobile-only case.",
                "没有连接终端，但守护进程在线。你发出第一条消息时，Pockly 会在电脑上以无头方式续跑该会话并把结果流回。这是常见的纯手机场景。"
              ),
            },
            {
              term: tr("Read-only", "只读"),
              desc: tr(
                "The computer is offline, or the conversation lives on a different computer. You can read history but not send until that computer is back online.",
                "电脑离线，或对话位于另一台电脑上。你可以阅读历史，但在那台电脑恢复在线前无法发送。"
              ),
            },
          ],
        },
      ],
    },

    // ──────────────────────────────────────────────────────── Permissions
    {
      id: "permissions",
      title: tr("Approving tool actions", "批准工具操作"),
      blocks: [
        {
          kind: "p",
          text: tr(
            "When the agent wants to run something that needs your approval, a permission card appears above the composer with the exact command or action. Tap Allow or Deny right from your phone.",
            "当 agent 想执行需要你批准的操作时，composer 上方会出现一张权限卡片，显示具体的命令或操作。直接在手机上点“允许”或“拒绝”。"
          ),
        },
        {
          kind: "note",
          text: tr(
            "Pockly only forwards the prompt and your decision. The agent (Claude Code / Codex) still owns the permission decision and runs the command itself — Pockly never executes anything on your machine.",
            "Pockly 只负责转发提示和你的决定。agent（Claude Code / Codex）仍然掌握权限决策并自行执行命令——Pockly 绝不会在你的机器上执行任何东西。"
          ),
        },
        {
          kind: "p",
          text: tr(
            "How often you're asked depends on the permission mode in Run config (below).",
            "被询问的频率取决于“运行配置”中的权限模式（见下文）。"
          ),
        },
      ],
    },

    // ───────────────────────────────────────────────────────── Run config
    {
      id: "run-config",
      title: tr("Run config", "运行配置"),
      blocks: [
        {
          kind: "p",
          text: tr(
            "The Run config pill in the composer opens a panel with three controls. They apply to the conversation you're in and are remembered for the next message.",
            "composer 中的“运行配置”药丸会打开一个含三项控制的面板。它们作用于你当前所在的对话，并会为下一条消息记住设置。"
          ),
        },
        {
          kind: "defs",
          items: [
            {
              term: tr("Model", "模型"),
              desc: tr(
                "Which model the agent uses for the next turn. The available options come from your agent and setup.",
                "agent 下一轮使用的模型。可选项来自你的 agent 和配置。"
              ),
            },
            {
              term: tr("Thinking effort", "思考深度"),
              desc: tr(
                "How much reasoning budget the agent spends: default, low, medium, high, xhigh, or max.",
                "agent 投入多少推理预算：default、low、medium、high、xhigh 或 max。"
              ),
            },
            {
              term: tr("Permission mode", "权限模式"),
              desc: tr(
                "Ask permissions (prompt for each action), Accept edits (auto-approve file edits), Plan mode (plan first, don't act), or Auto mode.",
                "Ask permissions（每次操作都询问）、Accept edits（自动批准文件编辑）、Plan mode（先规划、不执行），或 Auto mode。"
              ),
            },
          ],
        },
        {
          kind: "note",
          text: tr(
            "\"Bypass permissions\" is intentionally disabled — Pockly will not let a remote phone turn off all approval prompts.",
            "“Bypass permissions”被刻意禁用——Pockly 不允许远程手机关闭全部审批提示。"
          ),
        },
      ],
    },

    // ──────────────────────────────────────────────── Multiple computers
    {
      id: "multiple-computers",
      title: tr("Multiple computers", "多台电脑"),
      blocks: [
        {
          kind: "p",
          text: tr(
            "Connect up to 8 computers to one account — a work laptop, a home box, a dev VM. Each one keeps its own session list; nothing cross-mixes. Switch between them from the device menu in the workspace header, and the conversation list updates to that machine.",
            "一个账号最多可连接 8 台电脑——工作笔记本、家用主机、开发 VM。每台都保留自己的会话列表，互不混淆。在工作区头部的设备菜单中切换，对话列表会更新为那台机器的内容。"
          ),
        },
      ],
    },

    // ──────────────────────────────────────────────────────── Notifications
    {
      id: "notifications",
      title: tr("Notifications", "通知"),
      blocks: [
        {
          kind: "p",
          text: tr(
            "Turn on browser notifications in Settings to get pinged when a run needs you — typically when a task finishes, a run fails, or the agent is waiting on a permission decision. Notifications are delivered by web push, so they work even when the app is closed (best when installed to your home screen).",
            "在“设置”中开启浏览器通知，当一次运行需要你时就会收到提醒——通常是任务完成、运行失败，或 agent 在等待权限决定时。通知通过 Web Push 送达，因此即使应用关闭也能收到（添加到主屏幕后效果最好）。"
          ),
        },
        {
          kind: "p",
          text: tr(
            "Web push works on iOS Safari 16.4+ and Android Chrome. Pockly sends a lightweight summary; the full conversation loads when you open the app.",
            "Web Push 在 iOS Safari 16.4+ 和 Android Chrome 上可用。Pockly 只发送一个轻量摘要；完整对话会在你打开应用时加载。"
          ),
        },
      ],
    },

    // ─────────────────────────────────────────────────── Security & privacy
    {
      id: "security",
      title: tr("Security & privacy", "安全与隐私"),
      blocks: [
        {
          kind: "list",
          items: [
            tr(
              "Your agent runtime and API keys never leave your computer. The relay never sees them — it only forwards session events.",
              "你的 agent 运行环境和 API key 绝不离开你的电脑。relay 从不接触它们——只转发会话事件。"
            ),
            tr(
              "Traffic is protected by TLS in transit (HTTPS / secure WebSockets).",
              "传输全程由 TLS 保护（HTTPS / 安全 WebSocket）。"
            ),
            tr(
              "Session history is stored on Pockly's servers so you can pick up a conversation on any device. It is not end-to-end encrypted.",
              "会话历史存储在 Pockly 的服务器上，方便你在任意设备上接续对话。它不是端到端加密的。"
            ),
            tr(
              "Each browser is authorized as its own device. Use \"Sign this browser out\" to remove access from one browser, and revoke a computer from Devices to cut it off entirely.",
              "每个浏览器都作为独立设备被授权。用“将此浏览器登出”移除单个浏览器的访问；在“设备”中吊销一台电脑以彻底切断它。"
            ),
          ],
        },
        {
          kind: "note",
          text: tr(
            "Pockly never asks you to enter passwords, API keys, or card details into the agent. Those stay with your agent and your computer.",
            "Pockly 绝不会要求你把密码、API key 或银行卡信息输入到 agent 里。这些只保留在你的 agent 和电脑上。"
          ),
        },
      ],
    },

    // ────────────────────────────────────────────────────── Troubleshooting
    {
      id: "troubleshooting",
      title: tr("Troubleshooting", "故障排查"),
      blocks: [
        {
          kind: "defs",
          items: [
            {
              term: tr("\"This computer is offline\"", "“这台电脑已离线”"),
              desc: tr(
                "The daemon isn't reaching the relay. It should auto-run, but you can check it on the computer with the status command below, then refresh the page.",
                "守护进程未能连上 relay。它本应自动运行，你可以在电脑上用下面的 status 命令检查，然后刷新页面。"
              ),
            },
            {
              term: tr("\"Still connecting\"", "“仍在连接”"),
              desc: tr(
                "The daemon is reaching the relay — give it a few seconds. Sessions become writable once it's fully online.",
                "守护进程正在连接 relay——稍等几秒。完全在线后会话即可写入。"
              ),
            },
            {
              term: tr("Can't load a conversation / access not ready", "无法加载对话 / 访问未就绪"),
              desc: tr(
                "This browser isn't authorized yet. Sign in again on this browser, or open Pockly on the device that's already connected to the computer.",
                "此浏览器尚未获授权。在此浏览器重新登录，或在已连接到该电脑的设备上打开 Pockly。"
              ),
            },
            {
              term: tr("A conversation is read-only", "对话处于只读状态"),
              desc: tr(
                "The computer is offline or the conversation lives on a different computer. Bring that computer back online to steer again.",
                "电脑离线，或对话位于另一台电脑上。让那台电脑重新上线即可再次操控。"
              ),
            },
          ],
        },
        { kind: "subhead", text: tr("Check the daemon", "检查守护进程") },
        { kind: "command", code: "pockly-daemon status" },
        { kind: "subhead", text: tr("Update the daemon", "更新守护进程") },
        { kind: "command", code: "pockly-daemon update" },
      ],
    },

    // ───────────────────────────────────────────────────── Daemon CLI
    {
      id: "cli",
      title: tr("Daemon command reference", "守护进程命令参考"),
      blocks: [
        {
          kind: "p",
          text: tr(
            "You rarely need these — the daemon runs in the background on its own — but they're handy when something needs a nudge.",
            "你很少需要这些——守护进程会自行在后台运行——但当需要手动干预时它们很有用。"
          ),
        },
        {
          kind: "defs",
          items: [
            { term: "pockly-daemon setup", desc: tr("Connect this computer and (re)install the background service.", "连接这台电脑并（重新）安装后台服务。") },
            { term: "pockly-daemon serve", desc: tr("Run the daemon in the foreground (watch sessions, connect to relay).", "在前台运行守护进程（监视会话、连接 relay）。") },
            { term: "pockly-daemon login", desc: tr("Log this daemon into a Pockly account.", "把这个守护进程登录到一个 Pockly 账号。") },
            { term: "pockly-daemon status", desc: tr("Print daemon health.", "打印守护进程健康状态。") },
            { term: "pockly-daemon update", desc: tr("Check for and install a newer daemon (alias: upgrade).", "检查并安装更新版守护进程（别名：upgrade）。") },
            { term: "pockly-daemon remote", desc: tr("Enable or disable Remote Access for same-account mobile connect.", "为同账号手机连接开启或关闭远程访问。") },
          ],
        },
      ],
    },

    // ─────────────────────────────────────────────────────── Uninstall
    {
      id: "uninstall",
      title: tr("Uninstalling", "卸载"),
      blocks: [
        {
          kind: "p",
          text: tr(
            "Stop and remove the background service, then delete the binary. The exact steps depend on your OS:",
            "停止并移除后台服务，然后删除二进制文件。具体步骤取决于你的操作系统："
          ),
        },
        { kind: "subhead", text: "macOS" },
        {
          kind: "command",
          code:
            "launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.pockly.daemon.plist\n" +
            "rm ~/Library/LaunchAgents/com.pockly.daemon.plist",
        },
        { kind: "subhead", text: "Linux" },
        {
          kind: "command",
          code:
            "systemctl --user disable --now pockly-daemon.service\n" +
            "rm ~/.config/systemd/user/pockly-daemon.service",
        },
        { kind: "subhead", text: "Windows (PowerShell)" },
        { kind: "command", code: "schtasks /Delete /TN PocklyDaemon /F" },
        {
          kind: "p",
          text: tr(
            "Then remove the daemon binary, and revoke the computer from Devices in the workspace if you want to cut its access immediately.",
            "随后删除守护进程二进制文件；如果想立即切断它的访问，在工作区的“设备”中吊销这台电脑。"
          ),
        },
      ],
    },
  ];
}
