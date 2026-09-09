# 测试服务器

公开入口：http://172.203.225.147/uploader/
原人声工作台：http://172.203.225.147/

2026-09-09 已接入现有 80 端口：只有 IP 默认站点包含 nginx-subpath.conf，原域名站点未修改。
/uploader 自动跳转到 /uploader/。页面使用相对资源和下载地址；health、v1、webhooks 去掉前缀转到账号后端，保留真实客户端 IP，供限流使用。静态页及下载转到原 8081 服务。

部署位置：/opt/qiyin-uploader-test/current/site
账号服务：qiyin-uploader-test.service，127.0.0.1:18871
数据库：/var/lib/qiyin-uploader-test/licensing.sqlite3
下载：/opt/qiyin-uploader-test/downloads/
Nginx：/etc/nginx/sites-available/default 引用 /etc/nginx/snippets/qiyin-uploader-subpath.conf 和 qiyin-uploader-proxy.conf。
此次备份：/opt/qiyin-uploader-test/backups/20260908-170026（服务器 UTC）。

验证：公网原站、新页、JS、CSS、health、两个下载 HEAD 均 200；无斜线入口正确跳转。新子路径账号回归 18 项通过，临时账号已清理。

回滚：恢复备份 nginx-default 到 /etc/nginx/sites-available/default，恢复 index.html 和 site.js 到上述 site 目录，nginx -t 成功后 systemctl reload nginx。无需改数据库或原工作台程序。

当前 Mac 下载包仍连接本地 QA 账号服务，并未接入此 HTTP 云端账号服务；Windows 包尚未生成。支付尚未配置。以上限制也显示在下载页。
