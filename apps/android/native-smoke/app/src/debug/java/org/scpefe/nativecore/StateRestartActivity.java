package org.scpefe.nativecore;

import android.app.Activity;
import android.os.Bundle;
import android.os.Process;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import org.json.JSONObject;

/** Debug-only separate process used to prove app-private recovery after process death. */
public final class StateRestartActivity extends Activity {
    /** Stable test-only identity, never used by release code. */
    public static final String DOCUMENT = "abababababababababababababababab";
    /** Stable test-only opaque target, never used by release code. */
    public static final String TARGET = "android-target:restart-fixture";

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        File status = new File(getFilesDir(), "state-restart-status");
        try {
            boolean first = getIntent().getBooleanExtra("first", false);
            byte[] key = new byte[32];
            AndroidProfileSettings profile = new AndroidProfileSettings(this);
            AndroidWorkJournals journals = new AndroidWorkJournals(this);
            if (first) {
                profile.saveProfile(new JSONObject().put("name", "Ada")
                    .put("email", "ada@example.org").put("deviceName", "Android"));
                byte[] base = "base".getBytes(StandardCharsets.UTF_8);
                byte[] candidate = "exact candidate".getBytes(StandardCharsets.UTF_8);
                journals.write(DOCUMENT, TARGET, key, new JSONObject()
                    .put("text", "unsaved private text")
                    .put("baseRevision",
                        "1111111111111111111111111111111111111111111111111111111111111111")
                    .put("cursor", new JSONObject().put("start", 0).put("end", 0))
                    .put("target", TARGET).put("state", "pending-publication")
                    .put("updateTime", 12345)
                    .put("publication", new JSONObject().put("kind", "host-target")
                        .put("id", "22222222222222222222222222222222")
                        .put("target", TARGET).put("baseHash", hash(base))
                        .put("candidateHash", hash(candidate))
                        .put("base", android.util.Base64.encodeToString(base,
                            android.util.Base64.NO_WRAP))
                        .put("candidate", android.util.Base64.encodeToString(candidate,
                            android.util.Base64.NO_WRAP))
                        .put("stage", "prepared")));
            } else {
                if (!"Ada".equals(profile.loadProfile().getString("name"))
                        || journals.recover(DOCUMENT, TARGET, key).attention
                            != AndroidWorkJournals.Attention.PENDING_PUBLICATION) {
                    throw new IllegalStateException("restart state missing");
                }
            }
            Files.write(status.toPath(), ((first ? "first:" : "second:") + Process.myPid())
                .getBytes(StandardCharsets.US_ASCII));
        } catch (Exception error) {
            try { Files.write(status.toPath(), "error".getBytes(StandardCharsets.US_ASCII)); }
            catch (Exception ignored) { /* Test observes a timeout if files are unavailable. */ }
        }
    }

    private static String hash(byte[] data) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(data);
        StringBuilder hex = new StringBuilder();
        for (byte value : digest) hex.append(String.format("%02x", value & 0xff));
        return hex.toString();
    }
}
