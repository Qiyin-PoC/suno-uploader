#!/bin/sh
# First proof: Intel macOS. Build separately for other architectures.
set -eu
work="${QIYIN_FFMPEG_BUILD_DIR:-/tmp/qiyin-ffmpeg-build}"
lame="${QIYIN_LAME_PREFIX:-/usr/local}"
mkdir -p "$work/deps/lib" "$work/deps/include"
cp "$lame/lib/libmp3lame.a" "$work/deps/lib/"
cp -R "$lame/include/lame" "$work/deps/include/"
curl -fL https://ffmpeg.org/releases/ffmpeg-8.0.1.tar.xz -o "$work/ffmpeg-8.0.1.tar.xz"
tar -xf "$work/ffmpeg-8.0.1.tar.xz" -C "$work"
cd "$work/ffmpeg-8.0.1"
./configure --arch=x86_64 --cc='clang -arch x86_64' \
 --disable-x86asm --disable-autodetect --disable-doc --disable-debug --disable-network \
 --disable-everything --enable-ffmpeg --enable-swresample --enable-avfilter \
 --enable-protocol=file,pipe --enable-demuxer=wav,mp3,mov,ogg,flac,aac,aiff,matroska,concat \
 --enable-muxer=wav,mp3,ipod,ogg,flac,null \
 --enable-decoder=pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_f64le,pcm_s16be,pcm_s24be,pcm_s32be,mp3,mp3float,aac,alac,flac,opus,vorbis \
 --enable-encoder=pcm_s16le,pcm_s24le,pcm_s32le,libmp3lame,aac,flac \
 --enable-parser=aac,mpegaudio,flac,opus,vorbis \
 --enable-filter=aresample,anull,atempo,atrim,asetpts,concat,aformat \
 --enable-libmp3lame --extra-cflags="-I$work/deps/include" --extra-ldflags="-L$work/deps/lib"
make -j6
printf 'Built FFmpeg: %s/ffmpeg\n' "$PWD"
