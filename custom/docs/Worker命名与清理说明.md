# Worker 命名与旧实例清理（2026-10-16）

## 当前用途与配置

| 用途 | 当前 Worker | 配置文件 |
| --- | --- | --- |
| Emby 反代及面板 | emby-proxy | wrangler.jsonc |
| 优选 IP 订阅与受限转发 | preferred-ip-subscription | subscription/wrangler.jsonc |
| 更新备份、检查与回滚 | update-protection | update-guard/wrangler.jsonc |

主服务和更新保护通过 Cloudflare Worker ID 原地更名，保留 Secret、D1 绑定和版本，主域名/反代路由不变。Wrangler 两处 CF_WORKER_NAME 和主服务 UPDATE_GUARD 服务绑定已更新。不要再使用旧名称的本地配置发布，以免创建多余实例。

订阅的 workers.dev 主机名包含 Worker 名称。经用户明确同意一次性更换订阅链接，将 rex-emby-subscription-v2 原地更名为 preferred-ip-subscription，同步独立服务的 EMBY_SUB_DOMAIN/TUNNEL_DOMAIN 与主服务管理绑定。Secret、认证口令和节点配置不变；旧订阅及旧 WS Host 地址失效，需在 Surge 更新一次订阅地址并刷新节点。面板复制的新链接为准。反代域名和 Rex/Emby 客户端地址不变。

## 已清理与备份

故障旧实例 rex-emby-proxy 已删除（删除前仅在该无路由实例上试验原地更名，随后按同一个 Worker ID 对应实例删除）。清理前核对无反代路由、无其他 Worker 的服务绑定引用，并备份：四个实例代码、内容类型响应头、设置/Secret 名称、部署版本、Cron、路由清单以及共享 D1 SQL 导出。备份位于本机忽略的 backups/cleanup-rename-20261016/，含 SHA-256 校验。

Cloudflare 不返回 Secret 明文；现有私有凭据与配置仍受本地文件保护，未放入公开仓库。恢复旧代码时需从受保护的原配置源重新配置 Secret。数据库没有删除、改名或重新创建。

更名前的成功更新记录保留备份但标记为 superseded，不允许一键恢复带旧 CF_WORKER_NAME 的版本；需要时根据快照恢复源码，再使用当前命名配置发布。更名后重新执行受保护更新验证，形成适用于新名称的可回滚基线。

## 维护检查

1. 主服务仍用 npm run deploy；独立订阅用 npm run deploy:subscription；保护器用 npm run deploy:guard。
2. 检查原反代域名的面板/版本/登录、更新保护、订阅读取，订阅 URL 的口令与清理前一致、主机名符合用户批准的新名称。
3. 检查受限实际订阅链路，确认内层 TLS 正常及其他目标拒绝。
4. 重新列出 Worker、服务绑定、路由、Cron 与 D1。只清理本项目旧故障实例，不触碰其他项目的 Worker。
