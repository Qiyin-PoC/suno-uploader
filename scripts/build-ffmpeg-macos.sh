#!/usr/bin/env bash
#
# 为 macOS 构建「可随包分发」的自包含 FFmpeg。
#
# 为什么不用 Homebrew 版：Homebrew 的 ffmpeg 链接了 17 个 /opt/homebrew 下的 dylib，
# 复制到另一台机器会直接启动失败。这里用 --disable-autodetect + 显式 enable 列表，
# 只依赖 /usr/lib 与 /System/Library，并用静态 LAME 提供 libmp3lame。
#
# 为什么不能用 --disable-everything 了事：上传入口允许用户选择 .ape / .wma，
# 极简构建缺少 ape / asf demuxer 与对应解码器，会导致这两种格式上传失败。
#
# 构建产物只含 audio-only 能力，未启用 GPL / nonfree 组件。
# 注意：libmp3lame 为 LGPL，静态链接分发时需履行 LGPL 义务（随包提供许可证声明）。
#
# 用法：
#   bash scripts/build-ffmpeg-macos.sh
# 可用环境变量覆盖：
#   QIYIN_FFMPEG_BUILD_DIR  构建工作目录（默认 /tmp/qiyin-ffmpeg-build-arm64）
#   QIYIN_LAME_PREFIX       LAME 安装前缀（默认 /opt/homebrew）
#   QIYIN_FFMPEG_OUT        产物输出路径（默认 build/macos/vendor/ffmpeg/darwin-arm64/ffmpeg）

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FFMPEG_VERSION="8.0.1"
work="${QIYIN_FFMPEG_BUILD_DIR:-/tmp/qiyin-ffmpeg-build-arm64}"
lame="${QIYIN_LAME_PREFIX:-/opt/homebrew}"
out="${QIYIN_FFMPEG_OUT:-$ROOT/build/macos/vendor/ffmpeg/darwin-arm64/ffmpeg}"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "该脚本只支持 macOS" >&2
  exit 1
fi
if [ "$(uname -m)" != "arm64" ]; then
  echo "该脚本当前只构建 arm64 版本（当前主机：$(uname -m)）" >&2
  exit 1
fi

mkdir -p "$work/deps/lib" "$work/deps/include"

# 1. 准备静态 LAME。
if [ ! -f "$lame/lib/libmp3lame.a" ]; then
  echo "未找到静态库 $lame/lib/libmp3lame.a；请安装 lame 或设置 QIYIN_LAME_PREFIX" >&2
  exit 1
fi
cp "$lame/lib/libmp3lame.a" "$work/deps/lib/" 2>/dev/null || {
  # 上一次构建可能把该静态库设成了只读，先清掉再复制。
  rm -f "$work/deps/lib/libmp3lame.a"
  cp "$lame/lib/libmp3lame.a" "$work/deps/lib/"
}
rm -rf "$work/deps/include/lame"
# 必须用 -L 解引用：Homebrew 的 include/lame 本身是指向 Cellar 的符号链接，
# 用 -R 会复制出一个从 deps/include 出发无法解析的相对坏链接，configure 便找不到 lame.h。
cp -RL "$lame/include/lame" "$work/deps/include/"

# 2. 准备 FFmpeg 源码（已存在则复用，避免重复下载）。
src="$work/ffmpeg-$FFMPEG_VERSION"
if [ ! -x "$src/configure" ]; then
  echo "▶ 下载 FFmpeg $FFMPEG_VERSION 源码"
  rm -rf "$src"
  curl -fL "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" -o "$work/ffmpeg-$FFMPEG_VERSION.tar.xz"
  tar -xf "$work/ffmpeg-$FFMPEG_VERSION.tar.xz" -C "$work"
fi

# 3. 配置：在原可用配方基础上补齐 ape / asf(wma) 的解复用与解码能力。
#    编码/滤镜集合保持不变——后端只用这些。
cd "$src"
echo "▶ configure"
./configure \
  --arch=aarch64 --cc=clang \
  --disable-autodetect --disable-doc --disable-debug --disable-network \
  --disable-everything --enable-ffmpeg --enable-swresample --enable-avfilter \
  --enable-protocol='file,pipe' \
  --enable-demuxer='wav,mp3,mov,ogg,flac,aac,aiff,matroska,concat,ape,asf' \
  --enable-muxer='wav,mp3,ipod,ogg,flac,null' \
  --enable-decoder='pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_f64le,pcm_s16be,pcm_s24be,pcm_s32be,mp3,mp3float,aac,alac,flac,opus,vorbis,ape,wmav1,wmav2,wmapro,wmalossless' \
  --enable-encoder='pcm_s16le,pcm_s24le,pcm_s32le,libmp3lame,aac,flac' \
  --enable-parser='aac,mpegaudio,flac,opus,vorbis,ape' \
  --enable-filter='aresample,anull,atempo,atrim,asetpts,concat,aformat' \
  --enable-libmp3lame \
  --extra-cflags="-I$work/deps/include" \
  --extra-ldflags="-L$work/deps/lib"

# 4. 编译。
echo "▶ 编译"
make -j"$(sysctl -n hw.ncpu)"

# 5. 校验：必须自包含、必须是 arm64、必须支持 ape/asf。
echo "▶ 校验产物"
binary="$src/ffmpeg"
[ -x "$binary" ] || { echo "编译未产出 ffmpeg" >&2; exit 1; }

if "$binary" -hide_banner -version 2>/dev/null | grep -q -- '--enable-nonfree'; then
  echo "拒绝打包启用 nonfree 的构建" >&2
  exit 1
fi

non_system="$(otool -L "$binary" | tail -n +2 | awk '{print $1}' \
  | grep -vE '^/usr/lib/|^/System/Library/' || true)"
if [ -n "$non_system" ]; then
  echo "存在非系统动态库依赖，产物不可分发：" >&2
  echo "$non_system" >&2
  exit 1
fi

for format in ape asf; do
  if ! "$binary" -hide_banner -demuxers 2>/dev/null | grep -qE "^ *D +$format\b"; then
    echo "产物缺少 $format 解复用器" >&2
    exit 1
  fi
done

mkdir -p "$(dirname "$out")"
cp "$binary" "$out"
chmod +x "$out"
"$binary" -hide_banner -version 2>&1 | head -3 > "$(dirname "$out")/ffmpeg-build.txt"

echo "✓ 已输出 $(basename "$out")"
echo "  大小: $(du -h "$out" | cut -f1)"
echo "  支持: ape / asf(wma) 已启用，动态依赖仅限系统框架"
