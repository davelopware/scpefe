package org.scpefe.nativecore;

import static org.junit.Assert.*;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
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
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        ContentResolver resolver = context.getContentResolver();
        Uri uri = DocumentsContract.buildDocumentUri(TestDocumentsProvider.AUTHORITY,
            TestDocumentsProvider.DOCUMENT_ID);
        byte[] windows = asset("windows/windows-container.bin");
        try (OutputStream output = resolver.openOutputStream(uri, "rwt")) {
            assertNotNull(output);
            output.write(windows);
        }
        TargetPublication.Store store = new TargetPublication.Store() {
            @Override public byte[] read(String target) throws IOException {
                assertEquals(TARGET, target);
                try (InputStream input = resolver.openInputStream(uri)) {
                    if (input == null) throw new IOException("missing provider document");
                    ByteArrayOutputStream output = new ByteArrayOutputStream();
                    byte[] chunk = new byte[8192];
                    for (int count; (count = input.read(chunk)) != -1;)
                        output.write(chunk, 0, count);
                    return output.toByteArray();
                }
            }
            @Override public boolean canReplace(String target) { return true; }
            @Override public void replace(String target, byte[] candidate) throws IOException {
                try (OutputStream output = resolver.openOutputStream(uri, "rwt")) {
                    if (output == null) throw new IOException("provider cannot write");
                    output.write(candidate);
                }
            }
        };
        TargetPublication workflow = new TargetPublication(store);
        assertArrayEquals(windows, workflow.read(TARGET));
        byte[] candidate = Arrays.copyOf(windows, windows.length);
        candidate[candidate.length - 1] ^= 1;
        assertEquals(TargetPublication.Outcome.VERIFIED,
            workflow.publish(TARGET, windows, candidate));
        assertArrayEquals(candidate, workflow.read(TARGET));
        assertEquals(TargetPublication.Outcome.AMBIGUOUS,
            workflow.publish(TARGET, windows, "other".getBytes(StandardCharsets.UTF_8)));
        assertArrayEquals(candidate, workflow.read(TARGET));
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
