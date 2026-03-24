# file-transfer

`file-transfer` 是一个适合局域网内使用的轻量级文件互传与跨设备剪贴板工具。

它适合这些场景：

- 手机和电脑之间互传图片、文档、安装包
- 两台电脑在浏览器里直接互传文件
- 通过二维码把电脑上的下载链接发给手机
- 在电脑和手机、电脑和电脑之间共享一段可保留格式的文本

项目默认通过浏览器使用，不依赖客户端应用。

## 功能概览

首页提供三个独立入口：

- `电脑和电脑互传`
  使用两位口令进入同一个共享空间。任意一方上传文件后，另一方会立即看到同一份共享文件列表。
- `电脑和手机互传`
  电脑端生成二维码，手机扫码后完成上传或下载。
- `跨设备剪贴板`
  用来共享文本、命令和代码片段，保留原始换行和缩进，并支持手动清理。

主要能力：

- 支持文件上传、下载
- 支持目录上传
- 支持大文件分片上传
- 支持二维码访问
- 支持手动清理列表
- 支持文件自动过期删除
- 支持 Docker 部署
- 支持放在 `nginx`、Caddy、Traefik 等反向代理后面运行

## 运行要求

- Node.js 18 或更高版本
- 或 Docker 20+ / Docker Compose
- 如果要绑定域名，建议配合反向代理使用

## 快速开始

### 方式一：直接用 Node.js 启动

1. 克隆仓库

```bash
git clone <your-repo-url>
cd file-transfer
```

2. 安装依赖

```bash
npm install
```

3. 启动服务

```bash
npm start
```

默认监听：

- 地址：`0.0.0.0`
- 端口：`3011`

默认访问地址：

```text
http://127.0.0.1:3011/
```

如果你希望挂到二级路径，例如 `/ft`，启动前设置：

```bash
BASE_PATH=/ft npm start
```

此时访问地址会变成：

```text
http://127.0.0.1:3011/ft/
```

### 方式二：使用 Docker

项目已经提供了 `Dockerfile`。镜像内不包含 `nginx`，容器只运行应用本身，方便你按自己的需要加反向代理。

1. 构建镜像

```bash
docker build -t file-transfer:latest .
```

2. 运行容器

根路径部署示例：

```bash
docker run -d \
  --name file-transfer \
  -p 3011:3011 \
  -v $(pwd)/data:/app/storage \
  file-transfer:latest
```

二级路径部署示例：

```bash
docker run -d \
  --name file-transfer \
  -p 3011:3011 \
  -v $(pwd)/data:/app/storage \
  -e BASE_PATH=/ft \
  file-transfer:latest
```

访问地址：

- 根路径：`http://127.0.0.1:3011/`
- 二级路径：`http://127.0.0.1:3011/ft/`

### 方式三：使用 Docker Compose

如果你更习惯用 `docker compose`，可以使用下面这个最小示例：

```yaml
services:
  file-transfer:
    image: file-transfer:latest
    container_name: file-transfer
    restart: unless-stopped
    ports:
      - "3011:3011"
    environment:
      HOST: 0.0.0.0
      PORT: 3011
      BASE_PATH: ""
      FILE_TTL_HOURS: 24
      CLEANUP_INTERVAL_MINUTES: 15
      MAX_UPLOAD_MB: 10240
      ROOM_TTL_HOURS: 24
    volumes:
      - ./data:/app/storage
```

启动：

```bash
docker compose up -d
```

查看日志：

```bash
docker compose logs -f
```

停止：

```bash
docker compose down
```

## 部署步骤

下面是一套比较通用的部署流程。

### 1. 启动应用

你可以任选一种：

- `npm start`
- `docker run`
- `systemd` 托管 Node 进程

先确保服务已经能通过本机端口访问，例如：

```text
http://127.0.0.1:3011/
```

或：

```text
http://127.0.0.1:3011/ft/
```

### 2. 开放服务器端口

如果要让局域网内其他设备访问，请确保对应端口已放行，例如：

- `3011/tcp`

### 3. 配置反向代理

如果你使用域名，建议把 `file-transfer` 放到反向代理后面。

#### `nginx` 根路径反代示例

适合直接通过 `https://example.com/` 访问：

```nginx
server {
    listen 80;
    server_name example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name example.com;

    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    client_max_body_size 10G;

    location / {
        proxy_pass http://127.0.0.1:3011;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600;
        proxy_send_timeout 3600;
    }
}
```

#### `nginx` 二级路径反代示例

适合通过 `https://example.com/ft/` 访问。此时应用也需要设置 `BASE_PATH=/ft`。

```nginx
server {
    listen 80;
    server_name example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name example.com;

    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    client_max_body_size 10G;

    location /ft/ {
        proxy_pass http://127.0.0.1:3011/ft/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600;
        proxy_send_timeout 3600;
    }
}
```

配置完成后检查并重载：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

### 4. 验证访问

建议至少验证这几项：

- 首页可以打开
- 二维码可以正常生成
- 手机上传文件后，电脑端能看到
- 电脑上传文件后，手机端能下载
- 大文件上传不会被反向代理拦截

## 使用说明

### 电脑和电脑互传

1. 两台电脑都打开 `电脑和电脑互传`
2. 生成或输入同一个两位口令，例如 `A7`
3. 任意一方上传文件或目录
4. 双方页面都会自动刷新共享列表
5. 可以手动清理当前口令下的共享文件列表

口令规则：

- 格式为 `1个字母 + 1个数字`
- 只有口令一致的设备，才会看到同一份共享文件列表
- 只要每天有人访问，该口令会持续有效
- 连续一天无人访问，该口令会失效

### 电脑和手机互传

页面分为两部分：

- `设备投递到这里`
  手机扫码后，可以把文件上传到电脑当前页面
- `电脑发送到手机`
  电脑上传文件后，会生成手机可扫码访问的下载页

这个页面也支持手动清理：

- 接收列表
- 手机下载列表

### 跨设备剪贴板

提供两种方式：

- 电脑和电脑通过两位口令共享文本
- 电脑和手机通过二维码打开同一个文本板

特点：

- 保留原始换行和缩进
- 适合复制代码、命令、多行文本
- 支持手动清理

## 数据存储与清理

文件默认保存在：

- `storage/uploads/`

临时分片默认保存在：

- `storage/chunks/`

说明：

- 文件内容保存在磁盘
- 一部分共享状态保存在服务内存里
- 服务重启后，某些临时分享链接会失效

自动清理：

- 默认文件保留 `24` 小时
- 默认每 `15` 分钟执行一次清理
- 服务启动时也会先清理一次

## 环境变量

常用配置如下：

- `HOST`
  默认 `0.0.0.0`
- `PORT`
  默认 `3011`
- `BASE_PATH`
  默认为空，可设为 `/ft`
- `FILE_TTL_HOURS`
  文件保留小时数，默认 `24`
- `CLEANUP_INTERVAL_MINUTES`
  清理扫描间隔，默认 `15`
- `MAX_UPLOAD_MB`
  单文件最大上传大小，默认 `10240`
- `ROOM_TTL_HOURS`
  电脑互传口令无人访问后的失效小时数，默认 `24`

示例：

```bash
HOST=0.0.0.0 \
PORT=3011 \
BASE_PATH=/ft \
FILE_TTL_HOURS=24 \
CLEANUP_INTERVAL_MINUTES=15 \
MAX_UPLOAD_MB=10240 \
ROOM_TTL_HOURS=24 \
npm start
```

## `systemd` 部署示例

如果你希望开机自启，可以自己编写一个 `systemd` 服务，例如：

```ini
[Unit]
Description=File Transfer
After=network.target

[Service]
WorkingDirectory=/opt/file-transfer
ExecStart=/usr/bin/node /opt/file-transfer/server.js
Restart=always
Environment=HOST=0.0.0.0
Environment=PORT=3011
Environment=BASE_PATH=

[Install]
WantedBy=multi-user.target
```

然后执行：

```bash
sudo systemctl daemon-reload
sudo systemctl enable file-transfer
sudo systemctl start file-transfer
```

## FAQ

### 1. 手机能打开页面，但上传大文件失败

通常优先检查这几项：

- 反向代理是否设置了足够大的 `client_max_body_size`
- 服务器磁盘空间是否足够
- 上传超时时间是否过短
- 浏览器是否拿到了最新页面版本

### 2. 为什么上传目录时浏览器会提示“Only do this if you trust the site”

这是浏览器自己的安全提示，不是应用报错，网页本身无法关闭这个提示。

### 3. 文件会存在哪里

默认存储位置是：

- `storage/uploads/`

如果使用 Docker，建议把：

- `/app/storage`

挂载到宿主机目录上，避免容器删除后文件一起丢失。

### 4. 为什么服务重启后，部分旧链接失效了

因为一部分分享状态和临时会话保存在内存中。磁盘上的文件还在，但某些旧分享关系不会自动恢复。

### 5. 应该用根路径还是二级路径部署

- 如果你给这个项目单独域名，推荐根路径，例如 `https://transfer.example.com/`
- 如果你要挂到已有站点下面，推荐二级路径，例如 `https://example.com/ft/`

二级路径部署时，别忘了应用本身也要设置：

```bash
BASE_PATH=/ft
```

## 目录结构

```text
file-transfer/
├── public/          # 前端静态资源
├── storage/         # 上传文件与分片目录
├── nginx/           # nginx 配置示例
├── server.js        # 服务端入口
├── package.json
├── Dockerfile
└── README.md
```

## 注意事项

- 这是一个更适合局域网、家庭、办公室内部使用的工具
- 如果你直接暴露到公网，建议至少放在 HTTPS 和反向代理后面
- 大文件上传时，请同时检查：
  - 磁盘空间
  - 反向代理上传限制
  - 服务器超时设置

## License

项目根目录包含 `LICENSE` 文件。
