# Better Mail

本地优先的多账号桌面邮箱客户端，采用 [MIT](LICENSE) 开源协议。

## 下载

在 [GitHub Releases](https://github.com/liwenka1/better-mail/releases) 下载对应平台的安装包。

| 平台    | 架构                  | 安装包              |
| ------- | --------------------- | ------------------- |
| macOS   | Apple Silicon / arm64 | `.dmg`、`.zip`      |
| macOS   | Intel / x64           | `.dmg`、`.zip`      |
| Windows | x64                   | `.exe` 安装程序     |
| Linux   | x64                   | `.AppImage`、`.deb` |

当前发布未配置开发者签名或 macOS 公证，系统可能提示无法验证发布者。跨平台构建状态见 [GitHub Actions](https://github.com/liwenka1/better-mail/actions/workflows/desktop.yml)。构建成功不等同于所有系统和邮箱服务商均已完成实机验证。

## 功能

- 多账号统一收件，也可按账号、文件夹、星标和未读筛选。
- 本地搜索、分页与虚拟列表；按需缓存正文，支持离线阅读已缓存内容。
- HTML 隔离阅读、纯文本切换；操作栏固定，标题、正文、附件共用一个阅读滚动区。
- 远程图片默认阻止，可按封手动加载、隐藏和重新加载。
- 富文本写信、回复、转发、抄送、密送、附件与本地草稿。
- 持久化操作队列、增量同步、断线退避、发送结果与已发送副本状态展示。
- 账号名称和颜色编辑、隐藏及恢复；深浅外观和自定义主题色。

首次启动可以添加邮箱，或主动选择演示模式。演示账号仅模拟本地邮件和操作，不会连接邮箱服务或对外发信。

## 连接邮箱

### QQ、网易及通用 IMAP

先在邮箱服务商处开启 IMAP/SMTP，并生成客户端授权码或专用密码。在设置中选择邮箱预设，或填写服务器地址、端口和用户名。未使用隐式 TLS 的连接必须成功升级至 STARTTLS。

QQ、网易的新账号默认核验服务器已发送副本，缺失时尝试补存。已有账号保留自己的策略。副本补存与邮件投递独立，不会为补存而重新发送邮件。

### Gmail

在自己的 Google Cloud 项目启用 Gmail API，注册桌面 OAuth 客户端。在客户端填写 Client ID 及桌面客户端提供的 Client Secret（如有），通过系统浏览器授权。本机使用随机端口回调、state 和 PKCE；应用请求 `gmail.modify`。OAuth 应用的访问范围和可用账号取决于你的应用配置及服务商要求。

### Outlook.com / Microsoft 365

在 Microsoft Entra 注册允许目标账号类型的桌面应用，配置 `http://localhost` 回调和委托权限 `Mail.ReadWrite`、`Mail.Send`、`User.Read`。填写 Client ID 和适用的租户（通常为 `common`），再通过系统浏览器授权。授权流程也请求 `offline_access`。

## 从源码运行

需要 Node.js 24、pnpm 10，以及本机原生模块构建工具。项目通过 `packageManager` 和锁文件固定依赖。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

生产检查和构建：

```sh
pnpm check       # 依赖边界、TypeScript 和生产构建
pnpm notices     # 更新随应用分发的第三方声明
pnpm package:dir # 生成当前平台的应用目录包
```

安装器可使用 `pnpm exec electron-builder --publish never` 生成；先执行检查和声明生成。输出位于 `release/`。跨平台安装器在对应的原生 CI runner 中构建，包含对 Electron SQLite 原生模块的检查。

主要技术栈为 Electron、TypeScript、React、Tailwind CSS、shadcn/ui、TanStack Query / Virtual、Zustand、Tiptap、SQLite / Drizzle、ImapFlow、Nodemailer、MailParser，以及 Google OAuth2Client 和 Microsoft MSAL Node。

## 数据与限制

- 邮件直接与服务商同步，本地数据位于 Electron 的 `userData` 目录。凭据通过系统安全存储加密；邮件数据库本身没有应用级静态加密。
- 账号隐藏后继续同步，邮件不再出现在日常邮件视图、搜索、草稿和发件账号选择中；可以从设置恢复。
- 应用退出后停止收信；离线阅读仅覆盖已缓存正文。本地草稿暂不与服务商同步。
- 搜索覆盖本地元数据和摘要；当前不提供完整正文或附件全文搜索。
- 首次接入、同步位置失效或显式修复可能需要完整元数据扫描，大邮箱初次同步可能较久。
- 发送结果不确定时需要先核对服务商记录，避免重复投递。服务器副本延迟生成时，客户端补存仍可能与服务器产生重复副本。
- 普通 IMAP 邮件跨文件夹移动后可能产生新的本地标识；Gmail / Graph 的跨文件夹身份单独处理。
- 转发引用正文，原邮件附件需另行选择。Graph 当前发送上限为 3 MiB 原始 MIME；普通附件下载上限为 50 MiB。
- 垃圾箱邮件不提供彻底删除操作；跨设备同步、日历、联系人、规则和 AI 功能尚未提供。

## 发布

主分支和 Pull Request 会执行四个平台构建。在 GitHub 输入版本号即可发布新版本：

1. 打开 **Actions → Desktop build and release → Run workflow**。
2. 选择 **main** 分支，输入版本号，例如 `0.1.1` 或 `v0.1.1`，然后运行。也支持 `0.2.0-beta.1` 这样的 SemVer 预发布版本。
3. CI 自动提交 `package.json` 的版本变更并创建对应标签，随后从该提交构建四个平台。全部构建和校验成功后，才会汇总安装包与 `SHA256SUMS.txt` 并公开 GitHub Release。

手动发布只接受 `main`。如果准备版本时发现 `main` 已移动，需要从最新的 `main` 重新发起，避免混合不同提交的源码。未公开版本失败后可以重跑原 Run；已公开的版本会被拒绝，不会覆盖现有安装包。预发布版本会标记为 Pre-release。

也可以手动更新 `package.json` 后推送版本一致的标签（如 `v0.1.1`），沿用同一构建和发布流程。单个平台失败不会发布不完整版本。

项目代码使用 MIT 许可；第三方依赖和复制的基础组件保留各自版权与协议，见 [第三方许可声明](THIRD_PARTY_NOTICES.md)。
