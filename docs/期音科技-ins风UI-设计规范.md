# 期音科技 · Suno 歌曲上传器 — ins 风 UI 设计规范

> 配套原型：`docs/期音科技-ins风UI原型.html`（可双击在浏览器直接预览交互）
> 落地状态：V5.1.0 已按本规范落地到 `electron/renderer/`，并收敛为 3 核心入口。

## 一、设计定位

| 维度 | 说明 |
|---|---|
| 风格 | **ins 风极简**：柔光灰底 + 纯白卡片 + 大圆角 + 大量留白 + 品牌渐变点缀 |
| 关键词 | 干净 / 轻盈 / 高级感 / 少即是多 |
| 与旧版差异 | 去掉蓝色玻璃拟态 + 猫咪吉祥物 + 高饱和蓝，改为克制的中性色 + 一条紫粉渐变做品牌记忆点 |

## 二、设计系统（Design Tokens）

### 配色
| Token | 值 | 用途 |
|---|---|---|
| `--bg` | `#f4f5f7` | 页面底色 |
| `--bg-soft` | `#fafafa` | 侧边栏 / 输入底 |
| `--surface` | `#ffffff` | 卡片 |
| `--ink` | `#18181b` | 主文字 |
| `--ink-2` | `#3f3f46` | 次级文字 |
| `--muted` | `#71717a` | 辅助文字 |
| `--muted-2` | `#a1a1aa` | 弱化文字 |
| `--line` | `#ececef` | 分隔线 |
| `--line-2` | `#e4e4e7` | 输入框描边 |
| `--brand` | `#7c3aed` | 品牌主色（链接/焦点/开关） |
| `--brand-600` | `#6d28d9` | 品牌深色 |
| `--grad` | `135deg #8b5cf6 → #d946ef → #f43f5e` | 品牌渐变（Logo/主按钮/进度/激活态） |
| `--grad-soft` | `135deg #f5f3ff → #fdf2f8` | 浅渐变（tint 按钮/图标底） |
| `--success/--warn/--danger/--info` | `#10b981 / #f59e0b / #ef4444 / #2563eb` | 语义色（均带浅色底与边） |

### 字体
```
-apple-system, "SF Pro Display", "PingFang SC", "HarmonyOS Sans SC",
"Microsoft YaHei UI", Inter, system-ui, sans-serif
```
- 大标题 26px / 750；卡片标题 15px / 700；正文 13.5px；辅助 12px
- 数字用 `tabular-nums` 等宽对齐

### 圆角 / 阴影 / 间距
- 圆角：卡片 22px，输入框/按钮 12px，徽标/药丸 99px
- 阴影：极轻 `0 1px 2px rgba(16,16,20,.04)` + 悬浮加深，避免厚重投影
- 间距：4px 基数，卡片内边距 20px，卡片间距 18px

### 组件
按钮（primary 渐变 / ghost 白描边 / soft 灰 / tint 浅紫 / danger）、分段控件、开关、徽标、进度条（渐变 + 流光扫过动画）、队列项、空状态、提示条、统计卡。

## 三、信息架构（侧边栏 3 项）

| 模块 | 说明 |
|---|---|
| Suno 歌曲上传 | 登录 / 拖入 / 队列 / 模式 / 进度 / 歌词处理 |
| Suno 歌曲下载 | 粘贴链接 / 选格式 / 保存歌曲（复用下载模块） |
| 上传历史 | 统计 + 记录列表 |

> **V5.1.0 起**，为聚焦核心体验、消除空壳入口误触，已从侧边栏移除「格式转换」「音频剪辑」「伴奏 / 人声分离」三个模块入口（底层能力与后端保留，入口收敛；详见《V5.1.0-空壳模块UI收敛-优化说明.md》）。侧边栏不再显示旧版的 `1 / 2 / 3` 序号，改为图标 + 主副标题的 ins 风导航。

## 四、署名替换清单（已落地）

> **署名统一约定（V5.1.0）**：产品署名一律为「期音科技」，窗口标题为「期音科技 · Suno 歌曲上传器」，登录卡 eyebrow 为「QIYIN TECH」，用户默认昵称为「期音科技用户」。同步清除 `Jifeng` / `MeowCore` / `告白悸风` / `GBJF` / `Gaobai*` 残留。

### `electron/renderer/index.html`
| 项 | 状态 |
|---|---|
| `<title>` = `期音科技 · Suno 歌曲上传器` | ✅ 已落地 |
| 顶栏品牌区「期音科技 · Suno 歌曲上传器」 + 渐变 `brand-mark` | ✅ 已落地 |
| 侧边栏 3 入口（上传 / 下载 / 历史）+ 图标 | ✅ 已落地 |
| 移除 `1 / 2 / 3` 序号、三空壳模块 `nav-item` | ✅ 已落地 |

### `electron/renderer/app.js`
- 本地存储 key 前缀由 `jfmhstudio-*` 中性化为 `qiyin-*`（不影响功能，仅重置已存偏好）。
- 授权恒为内部永久有效（`licenseValid`），移除官网账号 / 激活 / 会员 UI 与拦截。

### `electron/main/main.js`
- `APP_DISPLAY_NAME = "期音科技"`；窗口标题 `期音科技 · Suno歌曲上传器`。
- 下载 User-Agent 由 `GaobaiSunoUploader/*` → `QiyinSunoUploader/*`。
- 托盘 tooltip 与「关于」弹窗均为「期音科技」署名。

### `backend/*` 与 `suno-login-extension/*`
- `lyrics_multilang.py` / `suno_download_cli.py`：署名「期音科技」。
- 扩展 manifest / popup / 使用说明：署名「期音科技」，popup 改 ins 渐变主按钮。

## 五、落地建议（已执行）

1. **先审原型**：在浏览器打开 `docs/期音科技-ins风UI原型.html` 确认风格方向。
2. **替换署名**：按上表全局替换文案（grep `Jifeng|MeowCore|告白|GBJF|jfmh` 可一次性定位）。
3. **换样式**：将原型的 `<style>` 与结构迁移到 `styles.css` / `index.html`，`app.js` 的 class 名需与新结构对齐（DOM id 全量保留，逻辑函数可复用）。
4. **图标**：原型用内联 SVG（`<symbol>`），已抽取为 `i-upload` / `i-download` / `i-history` / `i-music` 供侧边栏与空状态使用。
5. **Logo**：品牌 mark 采用渐变圆角方块 + 音符矢量，替换旧 logo 猫咪/蓝标。

> 需你确认：① 客服/管理员微信号替换成什么；② 产品名里的 `Suno` 是否显式出现（涉及商标，当前保留但弱化为副标题）；③ exe 是否改名（当前保持 `Suno歌曲上传器.exe`）。
