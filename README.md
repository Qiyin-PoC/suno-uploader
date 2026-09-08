# Suno歌曲上传器（期音科技 · 内部使用版）

期音科技内部使用的 Suno 歌曲上传工具，提供浏览器自动登录 Suno、音频切片拼接上传、歌词处理、
批量排队、歌曲下载、音频分离/剪辑等功能。**无需官网账号、无需激活码、无软件授权锁。**

## 功能

- 浏览器自动登录 Suno（CDP，打开浏览器完成登录后自动抓取 token）
- 音频切片拼接上传（本地低能量切点算法 + ffmpeg，稳定/快速两种模式）
- 歌词处理：中文同音替换 / 中文转拼音 / 粤语转粤拼 / 英语发音改写 / 韩语转罗马音 / 泰语转罗马音
- 批量排队上传、上传进度 / 切片统计 / 运行日志 / 打开切片文件夹
- Suno 歌曲下载（MP3 / WAV）
- 音频分离、音频剪辑（Editor）、格式转换（unlocker）

## 目录结构

    electron/             Electron 外壳（main.js 主进程 + preload.js + renderer/ 界面）
    backend/              Python 后端（切片、歌词、上传、下载）
    python-embed/         内置 Python 3.12（已装 requests + pypinyin，免外部 Python）
    vendor/ffmpeg/        内置 ffmpeg（切片/转码用）
    assets/               图标与吉祥物

## 运行（源码方式）

    npm install
    npm start            # 会用内置 python-embed，无需另装 Python

> 如需指定外部 Python，可设环境变量 SUNO_PYTHON 指向 python.exe。

## 打包成桌面程序

    npm run pack          # 生成 dist/win-unpacked/Suno歌曲上传器.exe（免安装绿色版）
    npm run dist          # 生成安装包

打包产物自带 Python + ffmpeg，可直接拷贝到其它机器运行，无需装任何依赖。

## 数据位置

数据（token / 上传历史 / 切片工作目录）保存在：%APPDATA%\\Suno歌曲上传器\\data

## 说明

- 上传走 Suno 官方接口（studio-api-prod.suno.com），用你自己（或组织）的账号，消耗积分。
- 首次使用请点「登录 Suno」，在弹出的浏览器里完成登录。
- 内部使用版免登录官网账号、免激活、无到期限制；所有模块均可用。
