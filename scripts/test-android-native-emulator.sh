#!/usr/bin/env bash
set -euo pipefail

# Uses the runner's already accepted SDK licences; never answers a new prompt.
sdk_dir="${ANDROID_HOME:?ANDROID_HOME must name a preinstalled SDK}"
test -f "$sdk_dir/licenses/android-sdk-license"
test -f "$sdk_dir/platforms/android-35/android.jar"
timeout 300s "$sdk_dir/cmdline-tools/latest/bin/sdkmanager" --install \
    'emulator' 'system-images;android-35;google_apis;x86_64' </dev/null
echo no | "$sdk_dir/cmdline-tools/latest/bin/avdmanager" create avd \
    --force --name scpefe-native-smoke \
    --package 'system-images;android-35;google_apis;x86_64'

"$sdk_dir/emulator/emulator" -avd scpefe-native-smoke -no-window -no-audio \
    -no-boot-anim -no-snapshot -gpu swiftshader_indirect \
    > /tmp/scpefe-android-emulator.log 2>&1 &
emulator_pid=$!
trap 'kill "$emulator_pid" 2>/dev/null || true' EXIT
timeout 180s "$sdk_dir/platform-tools/adb" wait-for-device
for attempt in $(seq 1 120); do
    if [[ "$("$sdk_dir/platform-tools/adb" shell getprop sys.boot_completed | tr -d '\r')" == 1 ]]; then
        break
    fi
    sleep 2
done
if [[ "$("$sdk_dir/platform-tools/adb" shell getprop sys.boot_completed | tr -d '\r')" != 1 ]]; then
    cat /tmp/scpefe-android-emulator.log >&2
    echo 'Android emulator failed to boot' >&2
    exit 1
fi
gradle -p apps/android/native-smoke --no-daemon connectedDebugAndroidTest
