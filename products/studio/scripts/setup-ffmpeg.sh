#!/bin/sh
# Build an unmodified, LGPL-only FFmpeg locally. No system installation or sudo.
set -eu
cd "$(dirname "$0")/.."
if [ "$(uname -s)" != Darwin ]; then
  echo 'Automatic setup currently supports macOS. Supply LGPL FFmpeg with libopenh264 via FFMPEG_PATH and FFPROBE_PATH on other platforms.' >&2
  exit 1
fi
mkdir -p .tools/build .tools/bin
cd .tools/build
archive=ffmpeg-9.0.2.tar.xz
if [ ! -f "$archive" ]; then curl --fail --location --max-time 180 https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz -o "$archive"; fi
printf '%s  %s\n' '8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e' "$archive" | shasum -a 256 -c -
if [ ! -d ffmpeg-9.0.2 ]; then tar -xJf "$archive"; fi
cd ffmpeg-9.0.2
studio_sdk="${STUDIO_SDK_PATH:-$(xcrun --sdk macosx --show-sdk-path)}"
./configure --cc="$(xcrun --find clang)" --sysroot="$studio_sdk" --prefix="$PWD/local" --disable-autodetect --disable-network --disable-doc --disable-debug --disable-ffplay --enable-videotoolbox --enable-audiotoolbox --enable-zlib > ../configure.log 2>&1
make -j4 HOSTLDFLAGS="-isysroot $studio_sdk" > ../make.log 2>&1
make install > ../install.log 2>&1
cp local/bin/ffmpeg local/bin/ffprobe ../../bin/
../../bin/ffmpeg -version
