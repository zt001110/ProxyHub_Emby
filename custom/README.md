# 定制版使用与更新

先阅读根目录 [CUSTOMIZATIONS.md](../CUSTOMIZATIONS.md)。本目录是可测试的通用源码，不含当前服务的私密配置；生产服务继续使用原有数据库、Secret 和独立更新检查器。

## 本地验证

使用 Node.js 25 和当前仓库的锁定依赖：

```sh
cd custom
npm ci
npm test
```

`npm ci` 的 prepare 阶段先验证 `upstream.lock.json`，从根目录作者代码生成回源观察补丁，再生成多模块更新所需的源码文本。来源或补丁结构不匹配时停止。GitHub Actions 执行相同测试。

## 同步作者

```sh
npm run upstream:status  # 仅拉取并显示是否有新作者提交
npm run upstream:sync    # 创建本地整合分支、合并、更新锁定记录、测试
# 或一次完成整合、测试、推送和创建草稿 PR：
npm run upstream:pr
```

整合前必须在干净的 `codex/rex-custom` 分支。脚本先使用 `gh repo sync --branch main --source MakkaPakka518/ProxyHub_Emby` 更新纯作者分支，再把上游提交合并到新的 `codex/upstream-...` 分支。失败时查看 `git status`、`git diff --cc`，修复后重新测试。若放弃尚未提交的整合，先保存需要的修改，再使用标准 `git merge --abort`；不要硬重置维护分支。

草稿 PR 通过审查后，用普通 merge commit 合并，保留作者历史与整合关系；不要对上游同步 PR 使用 squash/rebase 丢掉合并祖先。然后本地 `git switch codex/rex-custom && git pull --ff-only origin codex/rex-custom`。

## 准备本机私有发布目录

首次使用把 `site.example.json` 复制为 `site.local.json`，填写自己的私有部署目录和站点映射；此文件已被 Git 忽略。本次维护机器上已配置，包含域名与机器人名称映射，不含 Token 值。

```sh
npm run site:materialize
```

默认创建 `<私有部署目录>/backups/fork-release-<提交前缀>/`，拒绝覆盖已存在目录。输出目录保留仓库结构：根目录作者 `worker.js`，以及 `custom/` 下还原为实际站点的定制源码。

- 主 Worker 与检查器的实际 Wrangler 配置从现有私有部署目录复制；不会新建/删除 Cloudflare 服务或数据库。
- 管理员凭据文件与部署私有配置使用仅本地有效的符号链接，不复制进公开仓库。
- 发布目录位于已忽略的本机备份路径，不会被提交。
- 私有发布清单 `RELEASE.json` 记录 fork 提交，标记尚未部署。
- 进入输出目录的 `custom/` 后执行 `npm ci && npm test`。

如需另设输出路径，可传 `--output`，但必须仍位于私有部署目录的 backups/ 或本仓库已忽略的 custom/private-releases/ 内。该操作只生成可审查文件，不会写回当前部署工程，也不触发更新。

## 受保护的作者核心更新

在已经还原配置并测试通过的私有发布目录的 `custom/` 下：

```sh
npm run update:protected
```

此命令核对管理员凭据目的地与 Wrangler 绑定域名一致后，调用当前面板的受保护 `/api/deploy`，只替换作者核心；现有定制适配器和检查器继续保留。它等待备份、发布和检查结果，报告写入私有的 `backups/update-reports/`。检查失败由独立检查器回滚，关闭本地终端后仍由云端 Cron 接续；遇到超时先核对已有记录，不要直接重复提交。

## 更新自己的定制模块

若修改了 `custom/src/index.js`、测速模块、机器人逻辑、更新器或检查器，核心更新接口会刻意保留线上旧适配器，所以不能用它发布这些修改。应先完成针对性测试与代码/配置备份，再用 Wrangler 维护部署（主服务 `npm run deploy`，检查器 `npm run deploy:guard`）。这些维护部署不经过网页自动备份，因此不得省略手动备份和回滚点。

Cloudflare 编辑 Token、DNS Token、Telegram Token 仍仅存 Cloudflare。自动更新的独立 production-automatic 环境保存面板发布认证与基准指纹，只交给可信发布控制器；整合与测试任务没有生产凭据。普通 CI 和手动同步不部署。详见 [全自动更新与故障处理](docs/全自动更新与故障处理.md)。

## 文件定位

| 内容 | 文件 |
| --- | --- |
| 作者来源与版本锁定 | `upstream.lock.json`、根目录 `worker.js` |
| 面板/统计/机器人适配 | `src/index.js` |
| 测速、临时 DNS 与清理 | `src/entry-probes.js` |
| 多模块更新与保护入口 | `src/self-update.js` |
| 独立备份/检查/回滚 | `update-guard/worker.js` |
| 上游整合 | `scripts/sync-upstream.mjs` |
| 还原私有发布目录 | `scripts/materialize-site.mjs` |
| 受保护作者更新 | `scripts/update-panel.mjs` |
| 备份导出及修复说明 | `scripts/export-update-backup.mjs`、`docs/更新保护与故障修复.md` |
