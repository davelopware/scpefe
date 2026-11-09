package org.scpefe.nativecore;

import static org.junit.Assert.*;

import android.content.Context;
import android.content.Intent;
import android.os.Process;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Arrays;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Exercises Android app-private state with interruption and restart boundaries. */
@RunWith(AndroidJUnit4.class)
public final class PrivateStateInstrumentedTest {
    private static final String DOCUMENT = "12121212121212121212121212121212";
    private static final String OTHER = "13131313131313131313131313131313";
    private static final String TARGET = "android-target:fixture";
    private static final String REVISION =
        "3434343434343434343434343434343434343434343434343434343434343434";

    private File directory() throws IOException {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File directory = new File(context.getFilesDir(), "test-state-" + System.nanoTime());
        if (!directory.mkdirs()) throw new IOException("test directory unavailable");
        return directory;
    }

    private static String hash(byte[] value) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(value);
        StringBuilder hex = new StringBuilder();
        for (byte element : digest) hex.append(String.format("%02x", element & 0xff));
        return hex.toString();
    }

    private static JSONObject journal(String state) throws Exception {
        byte[] base = "encrypted base".getBytes(StandardCharsets.UTF_8);
        byte[] candidate = "exact encrypted candidate".getBytes(StandardCharsets.UTF_8);
        String encodedBase = android.util.Base64.encodeToString(base, android.util.Base64.NO_WRAP);
        String encodedCandidate = android.util.Base64.encodeToString(candidate,
            android.util.Base64.NO_WRAP);
        return new JSONObject().put("text", "private document content")
            .put("baseRevision", REVISION).put("cursor", new JSONObject()
                .put("start", 0).put("end", 0))
            .put("target", TARGET).put("state", state).put("updateTime", 12345)
            .put("publication", new JSONObject().put("kind", "host-target")
                .put("id", OTHER).put("target", TARGET)
                .put("baseHash", hash(base)).put("candidateHash", hash(candidate))
                .put("base", encodedBase).put("candidate", encodedCandidate)
                .put("stage", "prepared").put("purpose", "regular-save"));
    }

    @Test public void profileAndSettingsUseSharedShapeAndRejectSecrets() throws Exception {
        File directory = directory();
        AndroidProfileSettings store = new AndroidProfileSettings(
            new PrivateStateFiles(directory, () -> {}));
        JSONObject profile = store.saveProfile(new JSONObject()
            .put("name", " Ada ").put("email", "ada@example.org")
            .put("deviceName", "Android").put("password", "hidden secret"));
        assertEquals("Ada", profile.getString("name"));
        assertFalse(new String(Files.readAllBytes(new File(directory, "profile.json").toPath()),
            StandardCharsets.UTF_8)
            .contains("hidden secret"));
        assertEquals("Ada", new AndroidProfileSettings(
            new PrivateStateFiles(directory, () -> {})).loadProfile().getString("name"));
        JSONObject settings = store.saveSettings(new JSONObject()
            .put("regularSaveEnabled", true).put("regularSaveIntervalMs", 10000)
            .put("rawContent", "private document content"));
        assertTrue(settings.getBoolean("regularSaveEnabled"));
        assertFalse(new String(Files.readAllBytes(new File(directory, "settings.json").toPath()),
            StandardCharsets.UTF_8)
            .contains("private document content"));
        try { store.saveSettings(new JSONObject().put("regularSaveIntervalMs", 9999));
            fail("short interval was accepted"); }
        catch (IOException expected) { assertNotNull(expected); }
    }

    @Test public void journalRetainsExactCandidateAcrossNewStoreAndIdentityChecks()
            throws Exception {
        File directory = directory();
        byte[] key = new byte[32];
        Arrays.fill(key, (byte)0x5a);
        AndroidWorkJournals store = new AndroidWorkJournals(
            new PrivateStateFiles(directory, () -> {}));
        JSONObject pending = journal("pending-publication");
        store.write(DOCUMENT, TARGET, key, pending);
        String raw = new String(Files.readAllBytes(
            new File(directory, DOCUMENT + ".work-journal").toPath()), StandardCharsets.UTF_8);
        assertFalse(raw.contains("private document content"));
        assertFalse(raw.contains("exact encrypted candidate"));
        assertFalse(raw.contains(TARGET));
        AndroidWorkJournals restarted = new AndroidWorkJournals(
            new PrivateStateFiles(directory, () -> {}));
        AndroidWorkJournals.Recovery recovered = restarted.recover(DOCUMENT, TARGET, key);
        assertEquals(AndroidWorkJournals.Attention.PENDING_PUBLICATION, recovered.attention);
        assertEquals(pending.getJSONObject("publication").getString("candidate"),
            recovered.record.getJSONObject("publication").getString("candidate"));
        assertEquals(AndroidWorkJournals.Attention.UNREADABLE,
            restarted.recover(DOCUMENT, "android-target:different", key).attention);
        assertEquals(AndroidWorkJournals.Attention.NONE,
            restarted.recover(OTHER, TARGET, key).attention);
        byte[] wrong = new byte[32];
        assertEquals(AndroidWorkJournals.Attention.UNREADABLE,
            restarted.recover(DOCUMENT, TARGET, wrong).attention);
        Arrays.fill(key, (byte)0);
    }

    @Test public void failedAndInterruptedReplacementPreserveEarlierJournal()
            throws Exception {
        File directory = directory();
        byte[] key = new byte[32];
        AndroidWorkJournals store = new AndroidWorkJournals(
            new PrivateStateFiles(directory, () -> {}));
        store.write(DOCUMENT, TARGET, key, journal("unsaved"));
        AndroidWorkJournals interrupted = new AndroidWorkJournals(
            new PrivateStateFiles(directory, () -> { throw new IOException("injected failure"); }));
        try { interrupted.write(DOCUMENT, TARGET, key, journal("pending-publication"));
            fail("replacement succeeded"); }
        catch (IOException expected) { assertNotNull(expected); }
        assertEquals(AndroidWorkJournals.Attention.UNSAVED,
            store.recover(DOCUMENT, TARGET, key).attention);
        Files.write(new File(directory, DOCUMENT + ".work-journal").toPath(),
            "broken".getBytes(StandardCharsets.UTF_8));
        assertEquals(AndroidWorkJournals.Attention.UNREADABLE,
            store.recover(DOCUMENT, TARGET, key).attention);
        assertEquals("broken", new String(Files.readAllBytes(
            new File(directory, DOCUMENT + ".work-journal").toPath()),
            StandardCharsets.UTF_8));
    }

    @Test public void witnessPersistsAndFlagsReplacementWithoutOverwriting() throws Exception {
        File directory = directory();
        AndroidHeadWitnesses store = new AndroidHeadWitnesses(
            new PrivateStateFiles(directory, () -> {}));
        JSONObject first = witness(DOCUMENT, REVISION);
        assertEquals(AndroidHeadWitnesses.Comparison.FIRST, store.observe(TARGET, first));
        AndroidHeadWitnesses restarted = new AndroidHeadWitnesses(
            new PrivateStateFiles(directory, () -> {}));
        assertEquals(AndroidHeadWitnesses.Comparison.REPLACEMENT,
            restarted.observe(TARGET, witness(OTHER, REVISION)));
        assertEquals(DOCUMENT, restarted.read(TARGET).getString("documentId"));
        byte[] raw = Files.readAllBytes(new File(directory, "head-witnesses.json").toPath());
        assertFalse(new String(raw, StandardCharsets.UTF_8).contains(TARGET));
        raw[raw.length / 2] ^= 1;
        Files.write(new File(directory, "head-witnesses.json").toPath(), raw);
        assertEquals(AndroidHeadWitnesses.Comparison.UNREADABLE,
            restarted.inspect(TARGET, first));
    }

    @Test public void separateAppProcessRecoversPendingStateAfterDeath() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File status = new File(context.getFilesDir(), "state-restart-status");
        Files.deleteIfExists(status.toPath());
        context.startActivity(new Intent(context, StateRestartActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("first", true));
        String first = awaitStatus(status, "first:");
        int process = Integer.parseInt(first.substring("first:".length()));
        assertNotEquals(Process.myPid(), process);
        Process.killProcess(process);
        Files.deleteIfExists(status.toPath());
        context.startActivity(new Intent(context, StateRestartActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("first", false));
        String second = awaitStatus(status, "second:");
        assertNotEquals(process, Integer.parseInt(second.substring("second:".length())));
    }

    private static String awaitStatus(File file, String prefix) throws Exception {
        long deadline = System.currentTimeMillis() + 10000;
        while (System.currentTimeMillis() < deadline) {
            if (file.isFile()) {
                String state = new String(Files.readAllBytes(file.toPath()),
                    StandardCharsets.US_ASCII);
                if (state.startsWith(prefix)) return state;
                if (state.equals("error")) fail("state restart helper failed");
            }
            Thread.sleep(50);
        }
        throw new AssertionError("state restart helper timed out");
    }

    private static JSONObject witness(String documentId, String revision) throws Exception {
        return new JSONObject().put("documentId", documentId).put("headRevision", revision)
            .put("graph", new JSONArray().put(new JSONObject().put("revisionId", revision)
                .put("parentRevisionIds", new JSONArray())));
    }
}
