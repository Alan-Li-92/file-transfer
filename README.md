# file-transfer

局域网文件互传工具。

适合这样的场景：

- 打开首页后先选择模式：`电脑和电脑互传` 或 `电脑和手机互传`
- iPhone 扫二维码，把图片或文件上传到当前站点，Windows 浏览器直接下载
- Windows 浏览器上传文件，生成二维码，iPhone 扫码后直接下载
- A 电脑打开投递页上传文件，B 电脑打开主页直接下载
- A/B 使用一个两位口令互传，C/D 使用另一个两位口令互传，彼此互不可见

## 启动

1. 进入目录：`cd /home/alan/file-transfer`
2. 安装依赖：`npm install`
3. 启动服务：`npm start`

默认监听 `0.0.0.0:3011`，并按当前配置以 `/ft` 路径对外提供服务。

本机打开：
`http://127.0.0.1:3011/ft/`

同一局域网设备打开：
`http://你的电脑局域网IP:3011/ft/`

## Docker

项目已经提供了 `Dockerfile`，镜像内不包含 `nginx`，容器只运行这个文件互传服务。你可以按自己的需要在外部再加反向代理。

构建镜像：

`docker build -t file-transfer:latest /home/alan/file-transfer`

直接运行：

`docker run -d --name file-transfer -p 3011:3011 -v /你的本地目录/file-transfer-data:/app/storage -e BASE_PATH=/ft file-transfer:latest`

如果你不需要子路径访问，可以把 `BASE_PATH` 去掉，或者改成空值：

`docker run -d --name file-transfer -p 3011:3011 -v /你的本地目录/file-transfer-data:/app/storage file-transfer:latest`

常用环境变量：

- `HOST`：默认 `0.0.0.0`
- `PORT`：默认 `3011`
- `BASE_PATH`：例如 `/ft`
- `FILE_TTL_HOURS`：文件保留小时数
- `CLEANUP_INTERVAL_MINUTES`：清理扫描间隔
- `MAX_UPLOAD_MB`：单文件上传上限，默认 `10240`
- `ROOM_TTL_HOURS`：电脑互传口令无人访问时的失效小时数

## 使用方式

首页先显示三个模式入口：

- `电脑和电脑互传`：双方先对一个两位口令，再进入同一个工作台。任何一方上传后，对方直接就能在共享列表看到文件，不用选择自己是发送端还是接收端
- `电脑和手机互传`：进入二维码互传工作台，用来处理电脑和手机之间的文件上传、下载和扫码
- `跨设备剪贴板`：独立入口，专门用来解决电脑和电脑、电脑和手机之间的文本复制粘贴，保留原始换行和缩进，并支持手动清理

电脑和手机互传页面分成两部分：

- `设备投递到这里`：电脑页面会显示一个二维码和一个直接链接，手机扫码或另一台电脑直接打开投递页后，都可以把文件传上来，接收端会自动刷新文件列表
- `电脑发送到手机`：在电脑端选择文件上传，页面会生成一个下载二维码，iPhone 扫码后即可下载这些文件
- 上传时会显示实时进度条，大文件会按分片上传，稳定性更好

电脑和电脑之间互传的用法：

1. A 和 B 都打开 `电脑和电脑互传`
2. 生成或输入同一个两位口令，例如 `A7`
3. 任意一方上传文件或目录
4. 双方页面都会自动刷新共享列表，对方可以直接下载

口令规则：

- 口令格式是 `1个字母 + 1个数字`
- 只有口令一致的电脑，才能看到同一份共享文件列表
- 只要每天都有人打开这个口令对应的页面，它就会继续有效
- 如果连续一天都没人打开，这个口令会失效，下次需要重新对码

## 说明

- 文件保存在 `storage/uploads/`
- 当前版本的分享记录保存在内存里，服务重启后，旧分享链接会失效
- 默认会自动删除超过 `24` 小时的文件
- 清理任务默认每 `15` 分钟执行一次，也会在服务启动时先清一遍
- 默认单文件上传上限是 `10GB`
- 大文件会走分片上传，避免一次性整包传输
- 电脑互传支持选择整个目录上传
- 更适合家庭或办公室局域网内临时互传

## 作为后台服务运行

安装并立即启动用户级后台服务：

`bash /home/alan/file-transfer/install-user-service.sh`

常用命令：

- 查看状态：`systemctl --user status file-transfer.service`
- 启动服务：`systemctl --user start file-transfer.service`
- 停止服务：`systemctl --user stop file-transfer.service`
- 重启服务：`systemctl --user restart file-transfer.service`
- 查看日志：`journalctl --user -u file-transfer.service -f`
- 开机自启：`systemctl --user enable file-transfer.service`
- 取消安装：`bash /home/alan/file-transfer/uninstall-user-service.sh`

服务配置文件在 `file-transfer.service`，端口和监听地址可以在 `file-transfer.env` 里修改。
你也可以在 `file-transfer.env` 里调整：

- `FILE_TTL_HOURS`：文件保留小时数
- `CLEANUP_INTERVAL_MINUTES`：后台清理扫描间隔
- `MAX_UPLOAD_MB`：单文件上传上限，默认 `10240`
- `ROOM_TTL_HOURS`：电脑互传口令在无人访问时的失效小时数，默认 `24`

## 作为系统服务运行

如果你希望机器启动后自动运行，并且不依赖当前登录用户会话，使用系统级服务：

`bash /home/alan/file-transfer/install-system-service.sh`

常用命令：

- 查看状态：`sudo systemctl status file-transfer.service`
- 启动服务：`sudo systemctl start file-transfer.service`
- 停止服务：`sudo systemctl stop file-transfer.service`
- 重启服务：`sudo systemctl restart file-transfer.service`
- 查看日志：`sudo journalctl -u file-transfer.service -f`
- 开机自启：`sudo systemctl enable file-transfer.service`
- 取消安装：`bash /home/alan/file-transfer/uninstall-system-service.sh`

系统服务模板在 `file-transfer-system.service`。

## Nginx 反向代理

我已经在 `nginx/` 目录里放好了两种模板：

- `nginx/file-transfer.location.conf`：把站点挂到现有域名的 `/ft/` 路径下
- `nginx/file-transfer.example.com.conf`：给这个项目单独绑定一个域名

如果你想挂到二级路径，例如 `https://example.com/ft/`：

1. 把 `nginx/file-transfer.location.conf` 放到 `nginx` 配置目录
2. 在现有 `server` 块里 `include` 这个文件
3. 重新加载：`sudo nginx -t && sudo systemctl reload nginx`

更稳妥的做法是把它放成 `include` 片段，例如：
`/etc/nginx/file-transfer.location.inc`

如果你要传很大的文件，记得在对应 `location` 里配置足够大的上传上限，例如：
`client_max_body_size 10G;`

如果你当前主站就是 `code.allicn.top`，可以直接运行自动安装脚本：

`bash /home/alan/file-transfer/install-nginx-ft.sh`

卸载：

`bash /home/alan/file-transfer/uninstall-nginx-ft.sh`

如果你想绑定独立域名，例如 `https://transfer.example.com/`：

1. 复制 `nginx/file-transfer.example.com.conf`
2. 把里面的 `server_name`、证书路径改成你自己的
3. 启用配置后执行：`sudo nginx -t && sudo systemctl reload nginx`
