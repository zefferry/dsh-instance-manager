# DSH Instance Manager

> 0.14.0 起，用户可见名称统一为「分身」；本文与技术文档内部仍沿用「实例」这个技术称谓（英文界面仍是 Instance）。

一个可启用/停用的 DSH 插件，把桌面端变成「分身」工作台。

> 平台：**Windows x64**。插件依赖 Electron 桌面壳、Windows 原生目录选择器与 `taskkill`，其它平台暂不支持。

实例 = 独立内核副本 + 独立插件副本 + 独立配置 + 固定端口 + 可自选存储位置。它不绑定工作区，用来隔离并行项目；在实例里创建的工作区与会话会按会话记录归属，并在桌面端与其它实例中显示徽标。

## 行为（桌面端 vs 实例内）

| | 桌面端（当前运行的 DSH 桌面应用） | 实例内（由本插件启动的 DSH） |
| --- | --- | --- |
| 侧边栏 | 一级入口「实例」（自绘 outline 图标，风格与原生一致）+ 运行中数量徽标 | 不显示「实例」入口；左上角品牌替换为实例图标 + 实例名 |
| 分身列表 | 标题区是一张 960 内容列宽、与检索框同款背景的包裹条：左侧第一行 20px「分身」、第二行小字「管理相互隔离的 DSH 分身：独立内核、独立插件与固定端口」+ 行内 ⓘ（可悬停说明）；右侧是「刷新」「新建分身」按钮（新增在最右）；包裹条最下方是通栏四段筛选「全部 N / 运行中 N / 已停止 N / 错误 N」——无状态色、只有文字与数量；整条是浅内凹槽（inset 阴影），选中项用与标题栏相同的底色「浮起」并带一层极淡描边，未选中的三项则像陷在槽里，下方是整行搜索框；卡片 = 1:1 图标 + 名称 + 简介 +「局域网」「网页/桌面」徽标 + 右侧状态条；图标按钮启动（实心三角）/停止（方块），运行中额外出现重启；拖拽排序（握柄在右侧状态条旁，不占左缘）；双击（已停止→设置，运行中→打开） | — |
| 实例设置 | **修改后自动保存**（约 700ms 防抖，标题下显示「已自动保存」等状态；没有底部保存/返回按钮）、图标（1:1，点击直接选择本地图片；行尾有「获取提示词」按钮：打开关键词弹窗（6 组、共 145 个：风格/构图与形状/色彩/质感与光影/语义与用途/应用类型），可不选、可多选，确认后按六段模板生成完整提示词并复制到剪贴板）、名称/描述、访问方式（**网页 / 桌面**；选「桌面」时下方显示「桌面运行库」状态与下载按钮）、端口、局域网、自动打开、**插件**（两行入口：「可添加 N 个」+「添加插件」、「已添加 N 个」+「管理插件」，点进各自子页：添加页按「实验性 / 已安装」分组、行尾是加号；管理页可启停/移除，并展示内置插件配置说明；两页都使用插件自己的图标，无图标时回退通用 glyph；插件行不画分隔线/外框，靠行间距与 hover 底色区分；名称在上（14px）、介绍在下（13px 浅色），没有 `dsh.title` 的插件名称回退为包名、介绍回退为包描述；管理页「内置插件配置」固定在所有已添加插件上方，空态提示居中）、**数据**（内核版本+重建、存储目录+迁移，按钮在行右侧）、**删除**（按钮在行右侧） | — |
| 插件页 | 原生插件页（全局唯一的插件安装入口） | 原生「已安装」标签页；本插件移除了自己追加的「插件库」标签，并隐藏右上角「添加插件」的右半下拉；点击「添加插件」弹出 DSH 原生样式提示（请到主端口实例设置中添加） |
| 工作区 / 会话 | 会话级归属徽标、非本实例归属横幅；聚焦窗口时自动同步：`window focus` / `visibilitychange`(visible) / `pageshow` 触发一次 `POST /sync`（200ms 防抖），host 读取工作区索引并重放 `domain/changed`；空闲时**完全不轮询**。「工作区」右侧图标组有**刷新**按钮（手动 `/sync` + 原生 store 刷新，带旋转反馈） | 同左；会话归属本实例时不显示横幅 |
| 浏览器标签 | — | 页面标题 = 实例名；标签图标 = 实例图标：客户端会替换页面里**所有** `link[rel*=icon]` / `shortcut icon` / `apple-touch-icon` 的 href 与 type（含原生那条鲸鱼），并按 `iconVersion` 更新 URL |
| 桌面窗口 | — | 「桌面」访问方式：启动、双击运行中卡片、点设置里的「打开」时，由插件启动一个独立 Electron 窗口加载实例 Web UI——标题 = 实例名，窗口/任务栏图标 = 实例图标（从页面 favicon 光栅化后 `win.setIcon`）；关闭窗口不影响实例，停止实例会自动关窗。首次使用需下载 Electron 运行时（约 158 MB，缓存在 `~/.dsh/instances/_runtime`，所有实例共用，可在设置里手动下载）；顶部 34px 自绘条最左侧是「返回 DeepSeek Harness」按钮：最小化实例窗口并拉起桌面端本体，实例窗口保留在任务栏（再次双击卡片或打开实例会恢复并聚焦）；收起/展开侧边栏按钮同时识别「收起侧边栏」与「打开侧边栏」两种 aria-label，收起后仍能再展开；窗口无系统标题栏，顶部是 34px 自绘条：左侧「收起/展开侧边栏」按钮、右侧最小化/最大化/关闭，中间可拖动移动窗口，双击最大化；窗口/任务栏图标跟随页面 favicon 更新（实例自定义图标生成后自动替换，最多轮询 30 秒） |
| 选文件夹 | Windows 原生选择器 | Windows 原生选择器（实例 profile 由本插件固定为 native 选择器后端） |
| 内核 | 跟随桌面端当前内核 | 创建时复制并锁定版本，桌面升级只提示「可重建」 |

状态色：灰=已停止，黄=启动中，绿=运行中，红=错误。会话徽标外框也按会话状态高亮：运行=品牌色（发光）、等待输入=橙、错误=红、完成=绿、空闲=灰。实例未被归属的会话保持原生状态点。

图标：设置页点击图标直接打开本地文件选择（PNG/JPG，自动裁 1:1、≤512KB）；行尾「获取提示词」打开关键词弹窗：分 6 组共 145 个关键词，可不选/多选；确认后 host 用 `icon-prompt.md` 的六段模板（角色 / 使用场景 / 设计语义与应用信息 / 关键词约束 / 输出约束 / 自审与审查，占位符 `{{name}}`、`{{description}}`、`{{keywords}}`）替换生成完整提示词并复制到剪贴板；不选关键词时写「无额外偏好」的兜底句。host 提供 `GET /icon-keywords`、`POST /build-icon-prompt`（仅桌面端）；`/generate-icon`、`/icon-prompt` 保留给外部 AI 工具，界面不提供生成入口。

## 使用

1. 桌面端侧边栏「实例」→「新建实例」：填名称、描述、**存储位置（必填，默认 `~/.dsh/instances`，可用「选择目录」调起 Windows 原生选择器）**、可选端口（留空自动分配）、局域网开关、启动后自动打开浏览器开关。创建后**不会自动启动**。
2. 卡片右侧图标按钮：启动 / 停止；运行中还会显示「重启」。拖动卡片右侧（状态条左侧）的握柄可排序（顺序保存在 registry，跨重启保留）。双击已停止的卡片进入设置；双击运行中的卡片打开实例地址。
3. 设置页：点击图标直接选择本地图片（PNG/JPG，自动裁 1:1）；图标行最右侧「获取提示词」会打开关键词弹窗（可不选/多选，6 组共 145 个），确认后生成并复制完整提示词。访问方式可选「网页」或「桌面」；选「桌面」时同一区块会显示「桌面运行库」状态（已就绪/未安装/下载中）和「下载运行库」按钮，首次点「打开」也会自动下载（约 158 MB，一次即可，所有实例共用）。「插件」区是两行入口：
   - 「可添加 N 个」→「添加插件」子页：标题「将插件添加到「实例名」」，按「实验性 / 已安装」分组，行尾是描边方形的「＋」按钮，点击即添加；实验性插件来自实例内核（只写配置、不复制文件），社区插件复制独立副本。
   - 「已添加 N 个」→「管理插件」子页：标题「「实例名」的插件」；顶部固定「内置插件配置」说明（内置配置存在实例自己的 profile 里，运行时可在实例的插件页修改），下方是可启停、移除的插件列表；没有插件时显示居中的「还没有添加插件。」

   「数据」区含内核版本、重建内核、存储目录与迁移；「删除」为普通区块（不再红字高亮）。端口 / 局域网 / 自动打开 / 存储位置迁移均「下次启动生效」，插件修改需重启实例。
4. 在实例里：侧边栏「插件」仍可启停原生插件；「添加插件」会提示回桌面端实例设置页操作。创建工作区仍使用 Windows 原生文件夹选择器。
5. 跨端同步：在实例里创建/重命名工作区、创建会话后，桌面端与其它实例无需刷新即可看到（后台比较 revision 后调用原生 `sessions.refresh()` / `workspaces.refresh()`）。如果没等到自动同步，点「工作区」右侧的刷新按钮立即重拉。

## 数据位置

存储位置在创建时选择，默认 `~/.dsh/instances/<id>/`：

```
~/.dsh/instances/_runtime/electron/44.7.0/  # 桌面窗口共用的 Electron 运行时（首次使用下载，约 158 MB）
<存储位置>/<id>/instance.json              # 单实例记录（含 storageDir / profileName / kernelVersion / order / accessMode）
<存储位置>/<id>/kernel/<version>/          # 内核副本（约 405MB，创建时从 app.asar 解出）
<存储位置>/<id>/profile/                   # 实例 profile（package.json / cordis.patch.yml / node_modules 插件副本）
<存储位置>/<id>/library.json               # 创建时的桌面插件库快照
<存储位置>/<id>/logs/instance.log          # 运行日志（时间/事件/退出码）
<存储位置>/<id>/icon.png | icon.svg        # 实例图标（只保留一种）
~/.dsh/profiles/inst-<id>                  # 指向 <存储位置>/<id>/profile 的 junction（DSH 按 profile 名解析）
~/.dsh/instances/registry.json             # 实例记录索引（全局）
~/.dsh/instances/desktop.json              # 桌面端宿主标记（内核来源/运行时路径）
~/.dsh/instances/attribution/<id>.json     # 会话级归属（schemaVersion 4；每个实例写自己的文件，避免多进程互相覆盖）
```

删除实例会删除 `<存储位置>/<id>/`、profile 入口与它的归属文件，**保留工作区与会话**。旧版 `attribution.json`（工作区级）只读兼容，不再写入；旧实例（v0.2.0 及更早）不做迁移。

## 实现要点

- 纯插件实现（host + client 两半），不修改 DSH 源码；通过 `plugin_manager` 安装为 profile bundle（指向本仓库的 junction），可在「插件」页整体停用。
- 内核复制：桌面端主进程以 Electron-as-node 运行一次性复制脚本，从 `app.asar/dsh`（含 `app.asar.unpacked`）读出到 `<存储位置>/<id>/kernel/<version>`，约 405MB / 1.7 万文件。
- 实例启动：`<runtime>/node …/@deepseek-ai/dsh/lib/bin.js --profile inst-<id> --host 127.0.0.1 --port <port> --no-open`，stdout/stderr 写日志，解析 `dsh web: <url>` 并轮询健康检查（≤90s）。局域网开启时追加 `--trusted-host`/`--public-url`。
- 原生文件夹选择器：创建实例 profile 时写入受管 cordis patch 块——停用自适应的 `directory-picker` 行，插入 `@deepseek-ai/dsh-host-directory-picker-native` 与 `@deepseek-ai/dsh-client-ui-directory-picker-native`；每次启动前重新确保该块存在。这样即使实例绑定在局域网地址，也使用 Windows 原生 IFileOpenDialog。
- 工作区跨进程同步（惰性）：host 侧 `workspace-sync.js` 不再轮询，只在客户端触发时（`POST /sync`，由窗口聚焦/可见/页面显示事件触发）读一次 `<DSH_HOME>/storages/workspace.json`，把其它进程写入的工作区状态**合并**进本进程的 `workspaceRegistry`（`state` + `table.records`、`rebuildEntities`、补索引会话 header）：`sessionIds` 取并集（保留本进程刚创建、文件快照还没落盘的会话，避免聚焦同步后会话掉进「未分组」）、`workspaceIds` 保留本进程多出的工作区；聚焦触发的 `/sync` 会**重放整份合并快照**（全局 put + 每条工作区记录 put），即使某个客户端漏掉过一次增量（比如标签页在后台）也会被修正，不会把会话掉到「未分组」；宿主启动时的隐式同步仍只重放真正变化的记录，并且增量同步从不删除记录（删除只在下次宿主启动时随文件生效）。插件只读该文件，绝不写它。host 需注入 `workspaceRegistry`、`sessionPersistence` 服务才能拿到该对象。
- 会话级归属：实例内插件用 `ctx.on('session/created', …, { global: true })` 把**新出现的空白会话**放进内存 pending（不落盘）；再用 `ctx.on('session/event', …)` 监听，只有该会话在本实例里真正开始对话（`turn/start` 或 `user/message`）时才写入归属文件（`schemaVersion 4`，`session.id` + `session.header.cwd` + `createdAt`）。原因是 DSH 会**复用命名空白会话**（`dsh-session` 的 "reusing the named blank Session"）：如果空白草稿一出现就归因，桌面端随后复用同一会话继续对话会继承实例徽标。pending 只保留 24 小时；`parentSession`（子智能体）与 `createdAt` 早于本进程启动的会话一律忽略；旧 v2/v3 归属文件静默忽略（不备份、不迁移），历史误归属自动失效。归属只记录会话，不改绑工作区；桌面端合并读取所有实例的归属文件，按 `sessionOrigins` 提供给客户端。
- 跨端刷新：host 新增极轻量 `GET /revision`（只返回 `revisionDigest()`）与 `POST /sync`（惰性、单飞）；可见窗口每 3s 比较一次 revision，发现变化才同步（解决「网页端/后台可见但未聚焦」窗口不更新的问题），窗口聚焦/可见/页面显示时仍防抖调用 `/sync`，成功后刷新原生 store（`sessions.refresh()`；`workspaces` 控制器没有 refresh，侧栏由 host 重放的 `domain/changed` 经原生 feed 推送），因此无需常驻轮询。聚焦同步后会追加两次单发 `/sync`（1.5s、5s）再刷一次原生 store，覆盖跨进程写入的延迟。`/state` 仅在启动/停止等忙时与手动刷新时使用。
- 插件管理（桌面端）：`GET /instance-plugins` 返回实例插件、桌面安装库与实验性插件目录；`POST /add-plugin`、`POST /set-plugin-enabled`、`POST /remove-plugin`。社区插件在实例停止时复制依赖闭包、改 profile `dsh.profile.bundles` **与 `dependencies`**（可添加列表按 `dependencies ∪ bundles` 扫描，桌面端停用的插件也可添加）（原生插件页以此判断「已安装」）；实验性 `@deepseek-ai/dsh-*` 插件来自实例内核、桌面端本就提供，因此只写配置、不复制文件。实例内的插件安装入口被客户端拦截，改为原生样式提示。
- 图标：host 保存 `icon.png`/`icon.svg` 之一并返回 `iconContentType`；`GET /icon` 按扩展名返回 content-type；`POST /generate-icon` 立即返回并启动后台任务（重复请求提示「图标生成中，请稍后再试」），模型调用带强约束 system prompt、120s 超时与一次「修复重试」（把非法输出回喂、要求只输出完整 `<svg>`），`stripSvgReply`/`sanitizeSvg` 去代码围栏、截取首个 `<svg>`、补齐 `xmlns`/`viewBox` 并移除脚本/外链；`instanceView` 通过 `iconGenerating`/`iconError` 暴露任务状态。客户端在 `applyBranding` 中同步实例页标题、favicon 类型与左上角品牌。
- 插件图标：桌面端扫描插件库时读取包内 `package.json` 的 `icon` 相对路径（svg/png/jpg/webp/gif，≤256KiB）转 data URL，带 60s 缓存；添加/管理子页与后续插件管理直接使用插件自己的图标，无图标时回退中性 glyph（与原生插件页一致）。
- 桌面窗口（v0.10.0）：`shell/` 是一个极简 Electron 应用（无边框 `BrowserWindow` 加载实例 URL、标题与 AppUserModelID 由环境变量传入；`frame:false` + 自绘 34px 顶栏（收起侧边栏 / 最小化 / 最大化 / 关闭，`-webkit-app-region:drag`），preload 暴露 `__dshShell` IPC；页面 favicon 轮询 30s + `page-favicon-updated`，画到 256×256 canvas 后 `win.setIcon`、外链交给系统浏览器、加载失败显示内置错误页）；`host/shell.js` 负责下载/解压/校验 Electron 运行时（npmmirror→GitHub 双源、`DSH_INSTANCE_SHELL_DIR` 可覆盖用于测试）、`spawn` 时删掉继承来的 `ELECTRON_RUN_AS_NODE`、退出/关闭用 `taskkill /T`；`host/index.js` 用 `SHELLS` 表管理每实例窗口，`instanceView` 暴露 `shell`/`shellError`，`POST /open-shell`、`/close-shell`、`/prepare-shell-runtime` 三个路由；停止实例、停用插件、桌面退出都会先关窗。
- 公开服务：桌面端宿主通过 `ctx.provide('instanceManager', service)` 暴露统一接口（`listInstances` / `getInstance` / `listPlugins` / `listCatalog` / `setPluginEnabled` / `addPlugin` / `removePlugin`），并发出 `instance-manager/changed` 事件（`registry.changed` / `plugins.changed`）。插件描述符统一为 `{ id, instanceId, instanceName, name, title, description, version, source, enabled, removable, experimental, icon, tags }`，供后续「插件管理」类插件直接消费。
- 标题栏与布局：实例页与插件页共用 960 内容列；标题容器用 `div` + 显式 `margin/background/border` 重置，避免第三方主题对 `header` 的全局样式把标题做成独立卡片并脱离内容列。
- 浏览器标签图标：`applyBranding` 每轮都会把页面上所有 icon link 改写到 `/plugins/instance-manager/icon?id=…&v=…`（没有自定义图标时回退为实例首字母的 data URI），因此原生鲸鱼图标会被覆盖。
- 横幅/徽标：空闲会话行走 `sidebar.session.row.leading` 槽位（1:1 实例图标 + 按状态着色的圆角外框）；运行/等待/错误等非空闲行由原生状态点占据该槽，客户端用 MutationObserver 在对应 `[data-row-key="session:<id>"]` 行上注入同款徽标并隐藏原生状态点（双击打开归属实例）。另在会话悬浮卡提供归属行、在会话输入区顶部提供归属横幅。
- 配置继承：创建时把桌面端 `cordis.patch.yml` 原样复制一份作为基线，此后互不影响（已验证未知 override id 会被忽略）。
- 桌面端退出 / 插件停用时停止所有由它启动的实例；启动时清理残留（僵死 pid 标记为已停止）。

- 首次加载失败（宿主接口不可达）时，客户端会在 `shell.overlay` 槽显示固定错误浮层并提供「重试」按钮：此时 `/state` 尚未成功、面板还没注册，这是唯一能触达用户的入口；「重试」按钮会重新加载页面（宿主仍不可达时继续按 5s→30s 退避），成功后自动注册界面。
- 日志脱敏：写入 `instances/<id>/logs/instance.log` 的 URL 一律把 `token` / `access_token` 换成 `***`；`/state` 只在桌面端返回内存中的运行 URL，实例模式与 `/session` 不返回。
- 实例插件副本随宿主版本自动刷新：启动实例时比较 profile 内 `@local/dsh-instance-manager` 版本与宿主自身版本，不同则删除重拷（旧实例不会卡在旧插件版本）。

## 分身身份（v0.17.0）

- 会话徽标语义改为「最近执行者」：归因在首次执行时写 `createdAt`，此后每次 `turn/start` / `user/message` 刷新 `executedAt`；合并多个分身的归属文件时，同一会话取 `executedAt` 最新者。会话行徽标、悬停卡与输入区横幅统一显示「最近执行：<分身名>」。
- 桌面端主进程也会记录自己的执行（`attribution/__desktop__.json`，实例名「主端」）：在桌面端继续过的会话，徽标会切回主端，不再错误地停留在原分身。
- 助手回复信息栏（「用量 … tok」与时间之间）新增身份：分身自绘 outline 图标（三条圆角横线，与侧栏入口同一图形）+ 名称；桌面端执行的回复显示「主端」。实现方式：`conversation.chat.assistant-actions` 槽位只拿到 `{ messageId, sessionId }`，组件在该条消息的 `[data-turn-tail]` 内定位 `[class*="endInfo"]`，把身份元素插入到用量与时间之间；跨端同步后按最新归因重绘。
- 尺寸（v0.17.1）：信息栏身份图标与左侧「用量」图标一致——
  `.im-executor svg{width/height:calc(15px + var(--dsh-content-font-delta,0px))}`，间距 4px、行高 28px，随内容字号缩放；探针新增断言「identity icon size == usage icon size」。
- 验证：`ITER4 PASS`（归因 v4：桌面执行写主端后徽标消失、executedAt 递增）、`_work/probe-executor.mjs` PASS（真实会话 3 条回复：身份注入在用量右侧、名称「分身甲」、徽标标题「最近执行：分身甲」；移除归因后显示「主端」且徽标消失）、`ITER8 UI PASS` 回归。
- 生效：host 归因改动需重启 DSH；客户端刷新页面即可；已打开的实例窗口需重开。

## Surface 契约（v1，插件列表装饰器对接）

分身设置页的两个插件子页（**添加** / **管理**）在列表区域暴露 [插件列表 Surface 契约 v1](docs/plugin-surface-v1.md) 的 `data-*` 属性，供 `plugin-manager-plus` 这类装饰器识别并增强（改名/简介/图标/标签/搜索/添加到分身）。**分身管理不依赖装饰器存在**，装饰器关闭后 DOM 恢复原样。

| 位置 | 属性 |
| --- | --- |
| 列表区域根（`div.im-plugin-surface`，只包列表，不含返回/标题/hint/notice） | `data-plugin-surface="instance"`、`data-plugin-surface-version="1"`、`data-plugin-caps="rename desc tags icon search clone"`、`data-plugin-scope="instance:<实例 id>"` |
| 每个列表容器（`ul.im-plugin-list`） | `data-plugin-list` |
| 每张卡片根（`li.im-plugin-row`） | `data-plugin-package="<npm 包名>"`、`data-plugin-kind="package"`、`data-plugin-status="running\|disabled"` |
| 卡片槽位 | `data-plugin-icon`（图标容器）、`data-plugin-title`（名称唯一文本节点）、`data-plugin-desc`（有简介时才渲染）、`data-plugin-actions`（操作区） |

硬约束：只加属性——文本、布局、事件、样式表与既有行为均不变；属性写在 JSX props 里，React 重渲染自动保留；不使用 hash 类名做契约；分身子页不声明 `order`/`batch`/`uninstall`/`install-guard`（未实现的语义不写进 caps）。`data-plugin-scope` 只用于区分分身，装饰器的标签/覆盖仍按包名全局共享。

验证：`_work/probe-surface.mjs`（新增）逐行断言 surface 根、caps 精确集合、scope、`data-plugin-list`、卡片 package/title/icon/actions/kind/status/desc，并确认「内置插件配置」仍在列表上方、列表保持 960 列宽；截图 `_work/ui-shots-surface/01-add-surface.png`、`02-manage-surface.png`。原有 `ui-iter8` UI 探针（视觉/两行/删除确认/获取提示词等）保持通过。

## 开发 / 安装

```powershell
# 在 DSH 桌面端执行插件安装（本仓库已安装过一次，源目录即安装目录）
plugin_manager  action: install_bundle  target: <本仓库目录>
```

从 tarball / 仓库安装（推荐公开分发方式）：

```powershell
cd instance-manager
npm pack                       # 生成 local-dsh-instance-manager-<version>.tgz
plugin_manager  action: install_bundle  target: .\local-dsh-instance-manager-<version>.tgz
```

- `package.json` 的 `files` 必须覆盖所有运行时文件；`npm pack` 前会自动运行 `scripts/verify-pack-files.mjs`（也可手动 `node scripts/verify-pack-files.mjs`），漏列 `host/shell.js` 这类打包事故会直接报错。
- 安装包为 `@local/` scope 且 `private: true`，可通过目录 / tarball 安装，但不能 `npm publish`；如需公开发布到 npm，需要改包名与 `private`，并同步 `host/index.js` 里的 `PLUGIN_PACKAGE`。

- 源文件：`package.json`、`cordis.patch.yml`（插入 `instance-manager` 一行）、`host/index.js`（Host 插件，含 `/state`、`/revision`、`/sync` 等路由）、`host/workspace-sync.js`（跨进程工作区同步）、`host/shell.js`（Electron 运行时下载/窗口进程）、`shell/`（极简 Electron 桌面壳）、`client.js`（Web 客户端 bundle，含 3s revision 心跳与设置页）、`icon-prompt.md`（AI 图标提示词模板，六段结构，含 `{{name}}`/`{{description}}`/`{{keywords}}` 占位符）、`locale/*.json`、`assets/icon.svg`。
- 客户端改动用 HMR 可见；**host 改动需要重启 DSH 桌面端**（已安装包是指向本目录的 junction）。
- 离线验证脚本（不属于交付物）：`_work/mgr-iter10.mjs`（桌面窗口：运行时探测、开窗/关窗/停止自动关窗、坏运行时错误上报）、`_work/ui-iter8.mjs`（headless Edge：迭代 9 三处修复 + 迭代 10 桌面访问项 + 布局/同步回归）、`_work/ui-iter7.mjs`（两行工具栏与 960 列对齐、双徽标、无左侧握柄、空闲零轮询、聚焦同步侧栏改名、忙时短轮询、插件子页两行）、`_work/probe-real-lib.mjs`（真实桌面插件库 title/description 兜底）、`_work/ui-iter6.mjs`（两行工具栏与 960 列对齐、双徽标、setting 自动保存、插件自身图标）、`_work/mgr-wsmerge.mjs`（合并式工作区同步：保留本地新会话、只有变化才发事件、滞后快照不删本地工作区）、`_work/mgr-iter4.mjs`（图标后台任务、归属 v3 只记新会话；用 `Object.defineProperty(process.versions,'electron',…)` 模拟桌面环境）、`_work/ui-iter5.cjs`、`_work/probe-favicon.cjs`（实例模式独立 web 宿主：标题/品牌/全部 icon link 替换）、`_work/ui-iter4.cjs`，以及历史轮次的 `mgr-iter1/2/3`、`ui-iter1/2/3/4/5`、`ui-badge`、`ui-picker`。截图在 `_work/ui-shots-iter6` 等目录。

## 打包（v0.17.2 修复）

- **已修复**：`files` 漏列 `host/shell.js` 导致 tarball / 插件市场安装时 `ERR_MODULE_NOT_FOUND`（本地 link 安装不受影响所以一直没暴露）。现在 `files` 含 `host/shell.js` 与 `docs/plugin-surface-v1.md`。
- 新增 `scripts/verify-pack-files.mjs` 并挂到 `prepack`：发布前静态校验所有运行时文件（host 入口的 `./xxx.js`、`shell/*`、locale、图标、提示词、Surface 契约）都存在且被 `files` 覆盖，漏文件直接失败。校验成功时静默，失败输出缺失清单。
- `npm pack` 产物 15 个文件（含 `host/shell.js`）；已在临时 `DSH_HOME` 的 profile 里用 tarball 安装并 `import()` Host 入口验证通过。

## 已验证

- 第二十一轮（打包修复，v0.17.2）：`node scripts/verify-pack-files.mjs` 通过；`npm pack --dry-run` 共 15 个文件且含 `host/shell.js`、`docs/plugin-surface-v1.md`；tarball `local-dsh-instance-manager-0.17.2.tgz` 在临时 profile 中 `pnpm add` 安装后，`node` ESM `import()` `host/index.js` → `IMPORT OK dsh-instance-manager function inject=["webServer","workspaceRegistry","sessionPersistence","connection"]`（修复前该导入报 `ERR_MODULE_NOT_FOUND: host/shell.js`）。
- 第二十轮（分身身份，v0.17.0）：`node --check` `host/index.js`/`client.js` 全绿；`mgr-iter4` → `ITER4 PASS`（归因「最近执行者」：`session/created` 不再订阅、`turn/start` 写 `executedAt` 且后续执行递增、桌面写 `attribution/__desktop__.json` 后徽标消失、删除后恢复）；`_work/probe-executor.mjs` → `EXECUTOR PROBE PASS`（fixture 复制真实会话 `session-91ed6cd6…`：3 条回复的「用量 … tok」右侧出现分身图标 +「分身甲」，title「最近执行：分身甲」，移除归因后变「主端」且徽标消失；截图 `_work/ui-shots-executor/01-assistant-identity.png`、`02-desktop-fallback.png`）；`ITER8 UI PASS` 回归。

- 第十九轮（标题栏改版，v0.16.4）：`node --check client.js` 通过（balance final depth 0）；`ITER8 UI PASS` 新增断言：分段筛选条位于标题卡底部（head y=22 h=122，seg y=93 h=38）、四段计数「全部1/运行中0/已停止1/错误0」、刷新按钮仍在标题操作区（aria-label「刷新列表」）、搜索框位于标题卡下方（y=158）；其余既有断言全部通过。
- 第十八轮（迭代 15，v0.16.0）：`node --check` `host/index.js`/`client.js` 全绿；`ITER4 PASS`（归因 v4：空白草稿在 `session/created` 后不落盘、`session/event` 的 `turn/start` 才写入；旧 v2 文件静默忽略；`parentSession`/旧会话/未使用草稿均不归因）；`ITER8 UI PASS`（关键词 145 个/6 组、复制内容含六段 + 浏览器与 SVG 文件要求、空选择兜底、选中 chip 背景为 `label-primary`、弹窗标题固定、复制提示等）。
- 第十七轮（迭代 14，v0.15.0）：`node --check` `host/index.js`/`client.js` 全绿；`ITER8 UI PASS` 新增「获取提示词」弹窗断言：6 个关键词分组、145 个关键词、单选/多选切换、复制内容含六段结构 + 分身名称/简介 + 选中的「极简/蓝色系/磨砂」、空选择时出现「无额外偏好」兜底句、复制后弹窗关闭并提示已复制、滚动关键词时标题保持可见；`mgr-iter4` 的 `/icon-prompt` 断言更新为六段模板后 `ITER4 PASS`。
- 第十六轮（迭代 13，v0.13.0）：`node --check` 六文件全绿；`SHELL PROBE PASS` 新增 `backMinimized:true`（点返回后窗口最小化而非关闭，5 个顶栏按钮）；`SHELL REAL PAGE PASS`（真实页面返回最小化、侧栏收起/展开正常）；`HEARTBEAT PROBE PASS`（不派发 focus，仅靠 3s `/revision` 心跳：11 次 revision 探测 → 2 次 `/sync`，外部写入的工作区出现在侧栏）；`ITER8 UI PASS` 新增「复制提示词」按钮存在且右对齐（right=rowRight=1304）、点击显示占位提示；`ITER11 UI PASS`、`ITER4 PASS` 回归通过。
- 第十四轮（评审修复，v0.11.0）：`node --check` 六个文件全绿；`FIXES PASS`（并发 `/start` 只启动一个进程、第二次返回 `alreadyStarting`；`/stop` 等待进程退出并清空 pid；日志与 registry 脱敏为 `token=***`；`/state` 只返回可用的运行 URL；重建失败保留旧内核；emoji 名称通过；端口越界拒绝；重复 reorder 拒绝；越权 `/icon` 403；数组 registry/attribution 备份容错；创建失败回滚目录；创建中 cancel/delete 清理干净）；`mgr-iter4`、`WSMERGE` 回归通过；`SHELL PROBE` 与 `SHELL REAL PAGE` PASS（窗口尺寸持久化、最大化图标随状态切换、中英双语、官方 `data-windows-titlebar` 窗框兼容）；`ITER8 UI PASS`；`ITER11 UI PASS`（侧栏运行中角标、错误状态条可点开设置、卡片键盘 Enter、英文界面刷新按钮、首载失败浮层提示并可重试恢复）。
- 第一轮：创建 → 复制内核（0.2.1-rc.3）→ 生成 profile → 启动 → 健康检查 200 → 停止 → 删除；实例进程无残留、端口无占用。实例内插件库添加/移除、归属写入与清理、headless Edge 全流程截图。
- 第二轮（迭代 1）：存储位置必填 + 自定义目录（内核/profile/日志全部落在所选目录，profile 入口为 junction）、受管选择器补丁与 Windows 原生选择器 worker、工作区跨进程同步（1~2 秒内出现）、实例插件写入 profile 依赖后原生「已安装」可列出、设置页可滚动到底；`ITER1 PASS`、`ITER1 UI PASS`、`PICKER PROBE PASS`。
- 第三轮（迭代 2）：`node --check` 全绿；`ITER2 PASS`（会话级归属文件合并、revision 变化、排序、accessMode、1:1 图标版本、桌面端插件增删启停、删除时清理归属文件）；`ITER2 UI PASS`（卡片 1:1/状态条/图标按钮/单击无效/双击进设置、拖拽排序、设置内插件添加-停用-复用-移除、实例页标题与 favicon、原生「已安装」仍可用、添加插件弹窗提示且下拉半隐藏）；`BADGE PROBE PASS`（真实持久化会话行 16×16 圆角描边徽标 + 归属悬浮行 + 会话横幅）。
- 第四轮（迭代 3）：`node --check` 全绿；`ITER3 PASS`（SVG 图标生成与 content-type、实验性插件只写不复制、`/restart` 仅运行中且 pid 变化、会话归属 hook、删除清理）；`ITER3 UI PASS`（实例页与插件页等宽、运行中卡片重启+停止双按钮、设置「网页/桌面」「数据」「删除」布局、AI 图标弹窗预填模板、添加弹窗 760px 且分「实验性/已安装」、实例页 `.im-brand`=实例图标+名称、原生 wordmark 隐藏、favicon type）。
- 第六轮（迭代 5）：`node --check` 全绿；`ITER5 UI PASS`（标题与内容列同列 378=378、搜索框 582px 与筛选栏同一行相邻、工作区刷新按钮 20×20 且点击后 busy、设置两行入口「可添加 1 个 / 已添加 0 个」、添加子页标题/分组/加号、点击加号后写 profile bundles+dependencies 且 notice「已添加「终端」，重启实例后生效。」、管理子页标题/启停状态/内置插件配置）；`ITER5 FAVICON PASS`（实例模式页面标题=实例名、品牌=实例名、**全部 3 条 icon link 都被改写到 `/plugins/instance-manager/icon?id=inst-ui5&v=…`**、content-type 正确）；`mgr-iter4` 回归 `ITER4 PASS`。
- 第五轮（迭代 4）：`node --check` 全绿；`ITER4 PASS`（后台图标任务：生成立即返回、重复拒绝、修复重试 `calls=2`、失败保留旧图标、xmlns 注入；归属 v3：只记新会话、旧 v2 丢弃、旧会话/缺 createdAt/子代理会话忽略）；`ITER4 UI PASS`（标题栏与卡片同列 378=378、状态小字+info 逐字提示、启动按钮 36px + 实心三角 18px 无圆环、插件分区栏 `全部2/实验性2/已安装0` 与切区过滤、AI 点生成后立即关闭并后台提示、实例页品牌/favicon 回归）。
- 第七轮（迭代 6，v0.7.0）：`node --check` 全绿；`mgr-iter4` 回归 `ITER4 PASS`；`ITER6 UI PASS` 17 项（标题无状态小字且与内容列同列 364=364、筛选在搜索上方且搜索占满整行 960、卡片「局域网」「网页」双徽标、info 提示逐字、编辑后 1.8s 内「已自动保存」且 host 已写入、添加子页标题/960 左对齐/「图标演示插件」使用其 SVG 图标/「终端」回退 glyph、管理子页标题与图标）。
- 第八轮（迭代 7，v0.8.0）：`node --check` 全绿；`mgr-iter4` 回归 `ITER4 PASS`；`ITER7 UI PASS` 12 项（header 与 960 列同列 365=365、筛选在搜索上方、卡片双徽标、左侧无握柄且图标贴左 12px、空闲 4s 内 `/state` 0 次 `/sync` 0 次、聚焦触发一次 `/sync` 且侧栏外部改名出现「惰性同步工作区」、启动中保留 1s 短轮询且完成后归零、插件子页两行无 meta 行且名称 14px）。
- 第九轮（迭代 8，v0.9.0）：`node --check` 全绿；`WSMERGE PASS` 10 项（滞后快照保留本地新会话、无变化不发事件、其它进程新增会话时记录取并集并补索引 header、新增工作区全局 put、本地新建工作区不被滞后快照删除、增量同步不发 deleted）；`ITER7 UI PASS` 与 `mgr-iter4` 回归通过；插件添加/管理子页去掉行分隔线与外框，改为间距 + hover 底色。
- 第十一轮（迭代 10，v0.10.0）：`node --check` 全绿；`ITER10 PASS`（`DSH_INSTANCE_SHELL_DIR` 指向测试运行时：`hello.shellRuntime.installed=true`、`/prepare-shell-runtime` 就绪、`/open-shell` 从 `preparing` 到 `ready`、日志记录 shell pid、`/close-shell` 关闭、再次打开仍就绪、`/stop` 自动关窗、坏运行时通过 `shellError` 上报且 host 不崩溃）；`ITER8 UI PASS` 20 项（新增：设置里「桌面」可选、「桌面运行库」状态行存在）；`mgr-iter4` 回归通过。
- 第十三轮（迭代 10.2，v0.10.2）：`node --check` 全绿；`SHELL REAL PAGE PASS` 新增侧栏按钮自测（`sidebarToggle: 收起侧边栏 → 打开侧边栏 → 收起侧边栏`，收起后可再展开）；`ITER8 UI PASS`；「添加插件」行尾按钮改为无填充、1px 描边的 30px 方按钮。
- 第十二轮（迭代 10.1，v0.10.1）：`node --check` 全绿；`SHELL PROBE PASS`（独立页面：自绘栏 4 按钮、`#root` 下移 34px、`shell-icon 256x256`）；`SHELL REAL PAGE PASS`（真实 DSH 页面：栏存在、4 按钮、rootTop 34、无系统边框）；`SESSION SYNC PASS`（真实会话目录 + projcache + 工作区记录写入 fixture home，聚焦 `/sync` 后侧栏出现「会话同步测试」工作区与会话行、行上徽标存在，follow-up 同步生效）；`mgr-iter4`、`WSMERGE` 回归通过。
- 第十轮（迭代 9，v0.9.1）：`node --check` 全绿；`ITER8 UI PASS` 18 项（新增 `@fixture/dsh-desc-only`：无 `dsh.title` 时行标题=包名、介绍=包描述且仍为两行；管理页空态文字居中 `x=364,w=960`；「内置插件配置」在空态与已添加插件行上方 `y=130 < 228`；其余工具栏/徽标/贴左/零轮询/聚焦同步回归全过）；`mgr-iter4` 回归 `ITER4 PASS`；`REAL LIBRARY PASS`（真实桌面 profile 的 8 个社区插件：7 条为「包名 + npm 描述」两行、0 条标题=描述）。

- 第十五轮（迭代 11，v0.12.0）：`node --check` 全绿；`SHELL PROBE` / `SHELL REAL PAGE PASS`（顶栏新增最左「返回 DeepSeek Harness」按钮，共 5 个按钮；返回会隐藏当前窗口并拉起/聚焦桌面端，再点实例「打开」时通过 stdin `show` 复用同一窗口）；`ITER8 UI PASS` 新增两项（管理子页内点删除立即弹出「移除插件？」确认框；点设置页图标直接触发本地文件选择、不再出现 AI 菜单/对话框）；`ITER11 UI PASS`（侧栏运行中角标改为 14px 圆形、用 `label-primary`/`bg-base` 反转色，深色主题下不再发白变宽；设置页图标框 72×72 无内边距、无缝隙）。

## 已知限制 / 后续

- 桌面窗口需要首次下载 Electron 运行时（约 158 MB，仅 Windows x64）；第三方 Electron 首次运行可能触发 SmartScreen；下载失败会回退到浏览器打开并记录 `shellError`。
- 桌面窗口的任务栏图标来自页面 favicon：实例图标生成/替换后会自动更新，但 Windows 任务栏可能缓存旧图标，重开窗口即可。
- 归属徽标只对可交互会话行渲染（与原生一致：空白草稿行不渲染 leading 槽）；运行中会话行依赖 DOM 注入，原生 DOM 大改时需要同步调整选择器。徽标只出现在**实例内新建**的会话上：从桌面端创建、在实例里打开/继续的会话不会被标成该实例的会话（旧版误标记录随 schema v3 失效）。
- 局域网访问 UI 与参数已实现，但未做真实第二设备联调。
- 实例插件库来自桌面端当前**已安装**的插件（实时扫描 profile `dependencies ∪ bundles`；桌面端装了但停用的插件也能添加，与原生「已安装插件」口径一致；无 `dsh` 元数据的 helper 依赖会被跳过），社区插件「添加」仍以复制独立副本的方式实现，安装大插件会有一次复制开销。
- 存储位置迁移只在停止状态可用；迁移后旧目录清空。
- 同步策略（迭代 8，v0.9.0）：窗口聚焦/可见/显示时按需同步，host 采用**合并**而不是覆盖（见上），因此聚焦回来后新建会话不会掉进「未分组」；增量同步不删记录，其它窗口删除的工作区要到下次宿主启动才消失。空闲时**没有网络轮询**（不请求 `/state`、`/sync`），也没有对工作区文件的文件观察；窗口聚焦/可见/显示时被动同步一次，`workspaces` 侧栏由 host 重放的 `domain/changed` 更新。限制：两个窗口并排时只有聚焦的那个更新；长时间停留在同一窗口不自动刷新；启动/停止/AI 图标进行中才有 1 秒短轮询。客户端仍保留 1.5s 的轻量 DOM tick（扫描会话行徽标、纠正标题/favicon/品牌，不发网络请求），以及 body 级 MutationObserver，后续可收敛到侧栏容器。
- AI 生成图标入口已移除：设置页点击图标直接选择本地 PNG/JPG；行尾「获取提示词」只负责生成/复制提示词，不直接调用模型（/generate-icon、/icon-prompt 接口保留给外部工具）。
- 与 billion-context 的兼容：开启「局域网访问」后实例页面的 origin 是局域网 IP，bili 面板要求本机回环或在其配置里打开 `security.adminRelay: true`（bili 官方远程访问路径），因此面板会显示「远程地址无法访问本机代理」。要么关闭局域网访问让实例走 127.0.0.1，要么按 bili 配置开启 relay；本插件不替第三方改配置。
- 旧实例（v0.2.0 及更早）无向前兼容：归属改用按实例文件后，旧实例的工作区级归属不再显示（用户已确认开发前会删除旧实例）。
