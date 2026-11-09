package org.scpefe.nativecore;

import static org.junit.Assert.*;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.UriPermission;
import android.net.Uri;
import android.provider.DocumentsContract;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.Until;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.regex.Pattern;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Checks provider byte observations and safe decisions on a real emulator. */
@RunWith(AndroidJUnit4.class)
public final class DocumentTargetsInstrumentedTest {
    private static final String TARGET = "opaque:test";

    private static final class FaultStore implements TargetPublication.Store {
        byte[] image = "base".getBytes(StandardCharsets.UTF_8);
        boolean readable = true;
        boolean writable = true;
        boolean partial = false;
        boolean failAfterWrite = false;
        int writes = 0;

        @Override public byte[] read(String target) throws IOException {
            assertEquals(TARGET, target);
            if (!readable) throw new IOException("provider offline");
            return Arrays.copyOf(image, image.length);
        }

        @Override public boolean canReplace(String target) {
            assertEquals(TARGET, target);
            return writable;
        }

        @Override public void replace(String target, byte[] candidate) throws IOException {
            assertEquals(TARGET, target);
            writes++;
            image = Arrays.copyOf(candidate, partial ? candidate.length / 2 : candidate.length);
            if (failAfterWrite) throw new IOException("provider failed after write");
        }
    }

    @Test public void faultProviderPreservesSafePublicationDecisions() {
        FaultStore store = new FaultStore();
        TargetPublication workflow = new TargetPublication(store);
        byte[] base = Arrays.copyOf(store.image, store.image.length);
        byte[] candidate = "candidate".getBytes(StandardCharsets.UTF_8);
        store.image = "foreign".getBytes(StandardCharsets.UTF_8);
        assertEquals(TargetPublication.Outcome.AMBIGUOUS,
            workflow.publish(TARGET, base, candidate));
        assertEquals(0, store.writes);

        store.image = Arrays.copyOf(base, base.length);
        store.readable = false;
        assertEquals(TargetPublication.Outcome.AMBIGUOUS,
            workflow.publish(TARGET, base, candidate));
        assertEquals(0, store.writes);
        store.readable = true;

        store.writable = false;
        assertEquals(TargetPublication.Outcome.DEFINITE_FAILURE,
            workflow.publish(TARGET, base, candidate));
        assertEquals(0, store.writes);
        store.writable = true;

        store.partial = true;
        store.failAfterWrite = true;
        assertEquals(TargetPublication.Outcome.AMBIGUOUS,
            workflow.publish(TARGET, base, candidate));
        assertArrayEquals(Arrays.copyOf(candidate, candidate.length / 2), store.image);
        assertEquals(1, store.writes);

        store.image = Arrays.copyOf(base, base.length);
        store.partial = false;
        assertEquals(TargetPublication.Outcome.VERIFIED,
            workflow.publish(TARGET, base, candidate));
        assertArrayEquals(candidate, store.image);
        assertEquals(2, store.writes);
        assertEquals(TargetPublication.Outcome.VERIFIED,
            workflow.publish(TARGET, base, candidate));
        assertEquals(2, store.writes);
    }

    private static byte[] asset(String name) throws IOException {
        try (InputStream input = InstrumentationRegistry.getInstrumentation()
                .getContext().getAssets().open(name)) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            for (int count; (count = input.read(chunk)) != -1;) output.write(chunk, 0, count);
            return output.toByteArray();
        }
    }

    @Test public void localDocumentsProviderReadsWindowsFixtureAndVerifiesWrite() throws Exception {
        Context testContext = InstrumentationRegistry.getInstrumentation().getContext();
        Context targetContext = InstrumentationRegistry.getInstrumentation().getTargetContext();
        ContentResolver resolver = testContext.getContentResolver();
        Uri uri = DocumentsContract.buildDocumentUri(TestDocumentsProvider.AUTHORITY,
            TestDocumentsProvider.DOCUMENT_ID);
        byte[] windows = asset("windows/windows-container.bin");
        try (OutputStream output = resolver.openOutputStream(uri, "rwt")) {
            assertNotNull(output);
            output.write(windows);
        }
        PickerHostActivity.clearResults();
        Uri root = DocumentsContract.buildDocumentUri(TestDocumentsProvider.AUTHORITY,
            TestDocumentsProvider.ROOT_ID);
        Intent launch = new Intent(targetContext, PickerHostActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(DocumentsContract.EXTRA_INITIAL_URI, root);
        InstrumentationRegistry.getInstrumentation().startActivitySync(launch);
        UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
        UiObject2 file = device.wait(Until.findObject(By.text("test.scpefe")), 20_000);
        if (file == null) {
            UiObject2 roots = device.findObject(By.descContains("Show roots"));
            if (roots != null) roots.click();
            UiObject2 provider = device.wait(
                Until.findObject(By.text("SCPEFE test provider")), 10_000);
            assertNotNull("local document provider must appear in system picker", provider);
            provider.click();
            file = device.wait(Until.findObject(By.text("test.scpefe")), 10_000);
        }
        assertNotNull("Windows fixture must appear in system picker", file);
        file.click();
        Intent selected = PickerHostActivity.awaitResult(2_000);
        if (selected == null) {
            UiObject2 open = device.findObject(By.text(Pattern.compile("(?i)open")));
            assertNotNull("system picker must offer Open", open);
            open.click();
            selected = PickerHostActivity.awaitResult(10_000);
        }
        assertNotNull("system picker did not return", selected);
        assertEquals(uri, selected.getData());
        AndroidDocumentTargets targets = new AndroidDocumentTargets(targetContext);
        String key = targets.registerPicked(selected);
        assertTrue(targets.owns(key));
        assertFalse(key.contains(uri.toString()));
        boolean retained = false;
        for (UriPermission grant : targetContext.getContentResolver()
                .getPersistedUriPermissions()) {
            if (grant.getUri().equals(uri) && grant.isReadPermission()
                && grant.isWritePermission()) retained = true;
        }
        assertTrue("read and write grant must survive picker registration", retained);
        assertArrayEquals(windows, targets.read(key));
        assertTrue(targets.canReplace(key));
        assertEquals(AndroidDocumentTargets.CleanupOutcome.UNSUPPORTED,
            targets.removeCreated(key, windows));
        assertArrayEquals(windows, targets.read(key));

        NativeCore.Result nativeContext = NativeCore.nativeCreateContext();
        assertEquals(NativeCore.OK, nativeContext.status);
        try {
            assertEquals(NativeCore.OK,
                NativeCore.nativeOpen(nativeContext.handle, targets.read(key)).status);
            assertEquals(NativeCore.OK, NativeCore.nativeUnlock(nativeContext.handle,
                "0b4e79c5-7cfe-4b7c-b4f3-d89129cb7b5e"
                    .getBytes(StandardCharsets.UTF_8)).status);
            assertArrayEquals("alpha\n".getBytes(StandardCharsets.UTF_8),
                NativeCore.nativeRead(nativeContext.handle).data);
        } finally {
            assertEquals(NativeCore.OK,
                NativeCore.nativeCloseContext(nativeContext.handle).status);
        }

        byte[] candidate = Arrays.copyOf(windows, windows.length);
        candidate[candidate.length - 1] ^= 1;
        assertEquals(TargetPublication.Outcome.VERIFIED,
            targets.publish(key, windows, candidate));
        AndroidDocumentTargets reopened = new AndroidDocumentTargets(targetContext);
        assertArrayEquals(candidate, reopened.read(key));
        assertEquals(TargetPublication.Outcome.AMBIGUOUS,
            reopened.publish(key, windows, "other".getBytes(StandardCharsets.UTF_8)));
        assertEquals(AndroidDocumentTargets.CleanupOutcome.CHANGED,
            reopened.removeCreated(key, windows));
        assertArrayEquals(candidate, reopened.read(key));
        reopened.forget(key);
        assertFalse(reopened.owns(key));
    }

    @Test public void pickerContractsRequestOnlyDocumentGrants() throws Exception {
        Intent create = AndroidDocumentTargets.createPicker("notes.scpefe");
        Intent open = AndroidDocumentTargets.openPicker();
        assertEquals(Intent.ACTION_CREATE_DOCUMENT, create.getAction());
        assertEquals(Intent.ACTION_OPEN_DOCUMENT, open.getAction());
        assertTrue((open.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0);
        assertTrue((open.getFlags() & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0);
        assertTrue((open.getFlags() & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) != 0);
        AndroidDocumentTargets targets = new AndroidDocumentTargets(
            InstrumentationRegistry.getInstrumentation().getTargetContext());
        try {
            targets.registerPicked(null);
            fail("null picker result should fail");
        } catch (IOException expected) { /* no target is registered */ }
    }
}
