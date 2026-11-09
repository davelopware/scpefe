#!/usr/bin/env bash
set -euo pipefail

# Build the exact source archive for each requested ABI; no host libsodium or
# checked-in Android binary is used. Gradle packages the resulting two .so files.
root_dir="$(cd "$(dirname "$0")/.." && pwd)"
project_dir="$root_dir/apps/android/native-smoke"
build_dir="${SCPEFE_ANDROID_BUILD_DIR:-$project_dir/.build}"
ndk_dir="${ANDROID_NDK_HOME:-${ANDROID_HOME:-}/ndk/27.3.13750724}"
if [[ ! -f "$ndk_dir/build/cmake/android.toolchain.cmake" ]]; then
    echo "Android NDK 27.3.13750724 required at ANDROID_NDK_HOME or ANDROID_HOME/ndk" >&2
    exit 1
fi
if ! grep -q '^Pkg.Revision = 27.3.13750724$' "$ndk_dir/source.properties"; then
    echo "Android NDK revision must be 27.3.13750724 (r27d)" >&2
    exit 1
fi

sodium_version=1.0.20
sodium_sha256=ebb65ef6ca439333c2bb41a0c1990587288da07f6c7fd07cb3a18cc18d30ce19
archive="$build_dir/libsodium-$sodium_version.tar.gz"
mkdir -p "$build_dir"
if [[ ! -f "$archive" ]]; then
    curl --fail --location --retry 3 \
        "https://download.libsodium.org/libsodium/releases/libsodium-$sodium_version.tar.gz" \
        --output "$archive"
fi
echo "$sodium_sha256  $archive" | sha256sum --check --status

for abi in "${@:-x86_64}"; do
    case "$abi" in
        x86_64) sodium_script=android-x86_64.sh; sodium_prefix=westmere ;;
        arm64-v8a) sodium_script=android-armv8-a.sh; sodium_prefix=armv8-a+crypto ;;
        *) echo "Unsupported ABI: $abi" >&2; exit 1 ;;
    esac
    source_dir="$build_dir/source-$abi"
    rm -rf "$source_dir"
    mkdir -p "$source_dir"
    tar -xzf "$archive" -C "$source_dir" --strip-components=1
    (
        cd "$source_dir"
        ANDROID_NDK_HOME="$ndk_dir" LIBSODIUM_FULL_BUILD=Y NPROCESSORS=4 \
            "dist-build/$sodium_script"
    )
    sodium_dir="$source_dir/libsodium-android-$sodium_prefix"
    cmake -S "$root_dir" -B "$build_dir/core-$abi" -G Ninja \
        -DCMAKE_TOOLCHAIN_FILE="$ndk_dir/build/cmake/android.toolchain.cmake" \
        -DANDROID_ABI="$abi" -DANDROID_PLATFORM=android-26 \
        -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF \
        -DSODIUM_LIBRARY="$sodium_dir/lib/libsodium.a" \
        -DSODIUM_INCLUDE_DIR="$sodium_dir/include"
    cmake --build "$build_dir/core-$abi" --target scpefe --parallel 4
    package_dir="$project_dir/app/src/main/jniLibs/$abi"
    mkdir -p "$package_dir"
    cp "$build_dir/core-$abi/libscpefe.so" "$package_dir/"
done

notice_dir="$project_dir/app/src/main/assets/licenses"
mkdir -p "$notice_dir"
cp "$root_dir/LICENSE" "$notice_dir/SCPEFE.txt"
cp "$source_dir/LICENSE" "$notice_dir/libsodium.txt"
cp "$root_dir/third_party/zxcvbn-c/LICENSE.txt" "$notice_dir/zxcvbn-c.txt"
