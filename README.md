# 神杆 · 开放式 3D 台球（Claude-Fable-5-V2）

来源：[JarvisUni 开放式3D台球评测](https://topai.jarvisuni.com/Open-3D-Billiards/index.html) 中 **Claude-Fable-5-V2**（Claude 桌面版）的发布页，不是本地重写。

评测站只公开了打包后的单页 `claudefable5v2.html`。本仓库把它拆回原模块结构，并补上 three.js r160，方便本地运行。

## 运行

需要 Python 3（用于静态服务）。在项目根目录执行：

```bash
npm start
```

或：

```bash
python -m http.server 8080 --bind 127.0.0.1
```

浏览器打开 [http://127.0.0.1:8080/](http://127.0.0.1:8080/)

## 部署到 GitHub Pages

首次需要安装依赖：

```bash
npm install
```

确认远程仓库是 GitHub（本仓库为 `origin`），然后发布到 `gh-pages` 分支：

```bash
npm run deploy
```

发布后访问：[https://yanyue404.github.io/Open-3D-Billiards/](https://yanyue404.github.io/Open-3D-Billiards/)

仓库 Settings → Pages 的 Source 需设为 **Deploy from a branch**，分支选 **gh-pages**，目录选 **/**。

练习、人机、双人同屏、花式挑战可直接玩。联机对战依赖原项目未公开的 `server/server.js`（`ws://当前域名/ws`），评测站没有放出服务端，因此联机无法在本地还原。

## 目录

| 路径 | 说明 |
|------|------|
| `index.html` | 原页面 HTML/CSS，importmap 指向本地模块 |
| `src/` | 从发布页 importmap 里解出的原 JS（物理、规则、场景、AI 等） |
| `vendor/three.module.min.js` | three.js `0.160.0`（原版从 CDN 加载） |
| `assets/photo1.webp` | 场景相框照片 |
| `original/claudefable5v2.html` | 评测站原文件，未改动 |

操作：拖动瞄准，右侧拉杆蓄力，左下角加塞；方向键微调，`V` 俯视，`F` 自由视角。
