# Emby 专用优选订阅（Surge）

仅对现有 Emby 反代域名分流。Rex/Emby 客户端继续使用原反代链接；不修改 Surge 文件、不生成整份覆盖配置、不添加 FINAL 规则。服务端只接受该反代域名的 TCP 443，拒绝其他目标和 UDP。

## 与教程和 DNS 的关系

byJoey/yx-tools 是测速与上传工具，cfnew 才提供代理协议与客户端订阅。教程里的 yx 保存优选入口，p 指定 ProxyIP/中转；把它们放在环境变量不会自动让一个 HTTP Emby Worker 获得这些功能。

| 方式 | 生效范围 | 端口与选路 |
| --- | --- | --- |
| 原来的手动 DNS 优选 | 使用该域名的所有客户端，受 DNS 缓存影响 | A/AAAA 不存端口，多条记录不会自动选择最快 |
| 本功能的订阅 | 用户在 Surge 中明确分流到 Emby 策略组的流量 | 每条线路保留 IP/域名和 TLS 端口，可手动切换，不改正式 DNS |

本功能采用 Trojan WebSocket TLS 作为传输，订阅使用 Surge 官方支持的策略列表格式。与直接访问 Emby 反代相比增加了传输层，不能宣称必然更快；需要在用户实际网络测量。这里不是完整 cfnew 部署，不支持任意网站代理，也不提供 VLESS/xhttp/UDP。

## 面板操作

测速与 DNS 页面展开 **Emby 专用优选订阅 · Surge**：

1. 填写多行 IP/域名，可带端口；默认 443。支持 TLS 端口 443、2053、2083、2087、2096、8443，最多 32 条。也可填入勾选的已通过网页下载测速结果；这些结果当前为 IPv4:443。
2. 出站中转选择“绑定所选入口同一 IP:端口”或“使用单独的固定中转”。单独中转填一个可用地址。两种模式均不自动回落。
3. 点 **保存到订阅**，再点 **复制订阅地址**。Surge 更新策略列表后生效。
4. 按面板显示的两段配置，加入自己现有配置对应的 `[Proxy Group]`、`[Rule]` 段；Emby DOMAIN 规则放在可能先匹配到的广泛规则前。不要用这两段替换整份配置。

```ini
[Proxy Group]
Emby优选 = select, policy-path=面板复制的完整订阅地址, update-interval=86400

[Rule]
DOMAIN,你的Emby反代域名,Emby优选
```

策略列表不含 DIRECT/FINAL 等全局路由规则。订阅域名通过 `EMBY_SUB_DOMAIN` 配置，应与 Emby 分流域名不同，避免策略资源下载依赖其自身节点；现有部署使用原 Worker 已有的 workers.dev 入口承载订阅，无需创建优选 DNS 记录。若该入口在某网络不可达，订阅刷新会失败，应使用可达且独立的订阅域名。

## 同址与真实出口

同址模式只保证本服务尝试连接的中转地址与该线路入口的 IP:端口一致，失败则断开，不换备用地址。普通 CF 入站地址可能不能做中转，ProxyIP 也可能不能从本机作为入口访问。因此同一地址写进两处不代表线路可用。

目标最终观察到的出口还受中转实现、Cloudflare 任播和现有 Emby Worker 回源路径影响，**不能保证等于所选 IP**。独立中转模式会明确使用不同的固定中转地址，也不会假称入口出口一致。网页下载测速通过、保存配置、生成订阅均不等于订阅转发实测通过。

## 安全、备份与维护

- `/api/emby-subscription` 的读取/保存需要现有管理员会话；外部订阅路径用独立随机口令，Trojan 使用另一随机密码。订阅包含节点认证信息，不得公开。
- 配置存于现有 D1 `app_config` 的 `rex_emby_subscription_v1`，被现有更新保护配置快照覆盖；编辑列表无需发布 Worker。认证保存在 Secret 中，不放入 D1 配置或 Git。
- 生产 Secret：`EMBY_SUB_TOKEN`、`EMBY_TROJAN_PASSWORD`、`EMBY_TROJAN_HASH`。最后一项为密码的 SHA-224 十六进制。更换密码时两者同步更新；更换订阅口令会使旧订阅地址失效。
- 代码位于 `src/index.js`（入口/管理员鉴权）和 `src/entry-probes.js`（面板、存储、订阅、受限传输），现有多模块更新会保留两者。没有新运行时模块或生产依赖需要手动追加。
- 实现采用本项目的受限传输模块；cfnew 只作为功能与协议研究参考，未将其完整程序并入运行时。未使用的独立服务原型已移除，研究源码和临时凭据只保存在本机忽略的私有备份。
- 单元测试 `scripts/test-emby-subscription.mjs` 覆盖认证、稳定线路 ID、端口/地址约束、策略格式、密码与目标域名/端口拒绝。
- 本机私有 `scripts/verify-emby-subscription-live.mjs` 可通过实际 WebSocket/Trojan/内层 HTTPS 校验链路及禁止非 Emby 目标；不改 Surge。该脚本会临时保存待测订阅配置，维护时注意恢复用户列表，测试报告在私有 verification/。
- 首次安装需配置上述 Secret；已有服务不要重新生成覆盖。常规作者更新仍由用户点面板按钮触发，没有每小时任务。

参考：[yx-tools](https://github.com/byJoey/yx-tools)、[cfnew](https://github.com/byJoey/cfnew)、[Surge Trojan](https://manual.nssurge.com/policies/trojan.html)、[Surge 外部策略列表](https://manual.nssurge.com/policy-groups/policy-including.html)。
