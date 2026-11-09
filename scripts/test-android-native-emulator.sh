#!/usr/bin/env bash
set -euo pipefail

# Uses the runner's already accepted SDK licences; never answers a new prompt.
sdk_dir="${ANDROID_HOME:?ANDROID_HOME must name a preinstalled SDK}"
test -f "$sdk_dir/licenses/android-sdk-license"
test -f "$sdk_dir/platforms/android-35/android.jar"
# Give avdmanager and the emulator the same explicit profile location.
export ANDROID_USER_HOME="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/scpefe-android-user"
export ANDROID_EMULATOR_HOME="$ANDROID_USER_HOME"
export ANDROID_AVD_HOME="$ANDROID_USER_HOME/avd"
mkdir -p "$ANDROID_AVD_HOME"
timeout 300s "$sdk_dir/cmdline-tools/latest/bin/sdkmanager" --install \
    'emulator' 'system-images;android-35;google_apis;x86_64' </dev/null
echo no | "$sdk_dir/cmdline-tools/latest/bin/avdmanager" create avd \
    --force --name scpefe-native-smoke \
    --package 'system-images;android-35;google_apis;x86_64' \
    --path "$ANDROID_AVD_HOME/scpefe-native-smoke.avd"
if [[ ! -f "$ANDROID_AVD_HOME/scpefe-native-smoke.ini" ]]; then
    echo "AVD index missing from $ANDROID_AVD_HOME" >&2
    exit 1
fi
available_avds="$("$sdk_dir/emulator/emulator" -list-avds)"
printf 'Available Android AVDs:\n%s\n' "$available_avds"
if ! grep -Fxq scpefe-native-smoke <<< "$available_avds"; then
    echo 'Emulator cannot find the created scpefe-native-smoke AVD' >&2
    exit 1
fi

"$sdk_dir/emulator/emulator" -avd scpefe-native-smoke -no-window -no-audio \
    -no-boot-anim -no-snapshot -gpu software -verbose \
    > /tmp/scpefe-android-emulator.log 2>&1 &
emulator_pid=$!
cleanup_emulator() {
    local status=$?
    trap - EXIT
    if (( status != 0 )); then
        echo 'Android emulator diagnostics:' >&2
        "$sdk_dir/emulator/emulator" -accel-check >&2 || true
        "$sdk_dir/platform-tools/adb" devices -l >&2 || true
        if kill -0 "$emulator_pid" 2>/dev/null; then
            echo "Emulator process $emulator_pid is still running" >&2
        else
            echo "Emulator process $emulator_pid exited before the test completed" >&2
        fi
        tail -n 200 /tmp/scpefe-android-emulator.log >&2 || true
    fi
    kill "$emulator_pid" 2>/dev/null || true
    wait "$emulator_pid" 2>/dev/null || true
    exit "$status"
}
trap cleanup_emulator EXIT
timeout 300s "$sdk_dir/platform-tools/adb" wait-for-device
for attempt in $(seq 1 120); do
    if [[ "$("$sdk_dir/platform-tools/adb" shell getprop sys.boot_completed | tr -d '\r')" == 1 ]]; then
        break
    fi
    sleep 2
done
if [[ "$("$sdk_dir/platform-tools/adb" shell getprop sys.boot_completed | tr -d '\r')" != 1 ]]; then
    echo 'Android emulator failed to boot' >&2
    exit 1
fi
android_project="${SCPEFE_ANDROID_PROJECT:-apps/android/native-smoke}"
gradle_task=connectedDebugAndroidTest
if [[ "$android_project" != apps/android/native-smoke ]]; then
    gradle_task=:app:connectedDebugAndroidTest
fi
gradle -p "$android_project" --no-daemon "$gradle_task"
if [[ "$android_project" != apps/android/native-smoke ]]; then
    if [[ -n "${SCPEFE_ANDROID_INTEROP_OUTPUT:-}" ]]; then
        mkdir -p "$SCPEFE_ANDROID_INTEROP_OUTPUT"
        for name in interop-android-created interop-windows-edited; do
            for suffix in .scpefe -id.txt -content.txt; do
                "$sdk_dir/platform-tools/adb" pull \
                    "/sdcard/Download/scpefe-interop/$name$suffix" \
                    "$SCPEFE_ANDROID_INTEROP_OUTPUT/$name$suffix"
                test -s "$SCPEFE_ANDROID_INTEROP_OUTPUT/$name$suffix"
            done
        done
    fi
    exit 0
fi

# Exercise a real process boundary in two separate instrumentation invocations.
# The first invocation persists state, force-stop kills the target process, and
# the second verifies a different PID and exact pending candidate recovery.
# Gradle removes its managed test installation after connectedDebugAndroidTest.
app_apk=apps/android/native-smoke/app/build/outputs/apk/debug/app-debug.apk
test_apk=apps/android/native-smoke/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
test -f "$app_apk"
test -f "$test_apk"
"$sdk_dir/platform-tools/adb" install -r -t "$app_apk"
"$sdk_dir/platform-tools/adb" install -r -t "$test_apk"
instrumentation="$("$sdk_dir/platform-tools/adb" shell pm list instrumentation | tr -d '\r')"
printf 'Available instrumentation:\n%s\n' "$instrumentation"
if ! grep -Fq 'instrumentation:org.scpefe.nativecore.smoke.test/androidx.test.runner.AndroidJUnitRunner (target=org.scpefe.nativecore.smoke)' <<< "$instrumentation"; then
    echo 'SCPEFE Android test runner is not installed for the target app' >&2
    exit 1
fi
run_restart_phase() {
    local phase="$1" method="$2" output
    if ! output="$(timeout 180s "$sdk_dir/platform-tools/adb" shell am instrument -w \
        -e restartPhase "$phase" \
        -e class "org.scpefe.nativecore.PrivateStateInstrumentedTest#$method" \
        org.scpefe.nativecore.smoke.test/androidx.test.runner.AndroidJUnitRunner)"; then
        printf '%s\n' "$output" >&2
        return 1
    fi
    printf '%s\n' "$output"
    if ! grep -Fq 'OK (1 test)' <<< "$output"; then
        echo "Android $phase restart phase did not pass exactly one test" >&2
        exit 1
    fi
}
run_restart_phase write writeBeforeForcedProcessRestart
"$sdk_dir/platform-tools/adb" shell am force-stop org.scpefe.nativecore.smoke
run_restart_phase read recoverAfterForcedProcessRestart
