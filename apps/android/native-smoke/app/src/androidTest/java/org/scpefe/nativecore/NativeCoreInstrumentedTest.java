package org.scpefe.nativecore;

import static org.junit.Assert.*;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Exercises the packaged JNI bridge and C core in a real Android process. */
@RunWith(AndroidJUnit4.class)
public final class NativeCoreInstrumentedTest {
    private static byte[] utf8(String value) { return value.getBytes(StandardCharsets.UTF_8); }

    private static byte[] asset(String name) throws Exception {
        try (InputStream stream = InstrumentationRegistry.getInstrumentation()
                .getContext().getAssets().open(name)) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            for (int count; (count = stream.read(buffer)) >= 0;) {
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }

    private static byte[] fixture(String name) throws Exception {
        try (InputStream stream = InstrumentationRegistry.getInstrumentation()
                .getContext().getAssets().open("draft-v3/" + name)) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            int high = -1;
            boolean comment = false;
            for (int c; (c = stream.read()) != -1;) {
                if (comment) { if (c == '\n') comment = false; continue; }
                if (c == '#') { comment = true; continue; }
                if (Character.isWhitespace((char)c)) continue;
                int digit = Character.digit((char)c, 16);
                if (digit < 0) throw new IllegalArgumentException("bad hex fixture");
                if (high < 0) high = digit;
                else { output.write((high << 4) | digit); high = -1; }
            }
            if (high >= 0) throw new IllegalArgumentException("odd hex fixture");
            return output.toByteArray();
        }
    }

    @Test public void opensAndUnlocksRevisedV3Fixture() throws Exception {
        byte[] encrypted = fixture("valid/baseline-container.hex");
        byte[] password = utf8("correct horse battery staple");
        byte[] wrong = utf8("incorrect password");
        assertEquals(0, NativeCore.nativeActiveContextCount());
        for (int i = 0; i < 20; i++) {
            NativeCore.Result created = NativeCore.nativeCreateContext();
            assertEquals(NativeCore.OK, created.status);
            try {
                long handle = created.handle;
                assertEquals(NativeCore.OK, NativeCore.nativeOpen(handle, encrypted).status);
                assertEquals(NativeCore.INVALID_STATE,
                    NativeCore.nativeOpen(handle, encrypted).status);
                assertEquals(NativeCore.LOCKED, NativeCore.nativeRead(handle).status);
                assertEquals(NativeCore.AUTHENTICATION_FAILED,
                    NativeCore.nativeUnlock(handle, wrong).status);
                assertEquals(NativeCore.OK, NativeCore.nativeUnlock(handle, password).status);
                NativeCore.Result journalKey = NativeCore.nativeJournalKey(handle);
                assertEquals(NativeCore.OK, journalKey.status);
                assertArrayEquals(fixtureDocumentId(), journalKey.documentId);
                assertEquals(32, journalKey.data.length);
                Arrays.fill(journalKey.data, (byte)0);
                NativeCore.Result read = NativeCore.nativeRead(handle);
                assertEquals(NativeCore.OK, read.status);
                assertArrayEquals(utf8("alpha\n"), read.data);
                assertArrayEquals(fixtureDocumentId(), read.documentId);
                Arrays.fill(read.data, (byte)0);
                assertEquals(NativeCore.OK, NativeCore.nativeCloseContainer(handle).status);
                assertEquals(NativeCore.INVALID_STATE, NativeCore.nativeRead(handle).status);
            } finally {
                assertEquals(NativeCore.OK,
                    NativeCore.nativeCloseContext(created.handle).status);
            }
            assertEquals(0, NativeCore.nativeActiveContextCount());
        }
        Arrays.fill(password, (byte)0);
        Arrays.fill(wrong, (byte)0);
    }

    private static byte[] fixtureDocumentId() {
        byte[] id = new byte[16];
        for (int i = 0; i < id.length; i++) id[i] = (byte)(0x10 + i);
        return id;
    }

    @Test public void opensDocumentProducedOnWindowsRunner() throws Exception {
        byte[] encrypted = asset("windows/windows-container.bin");
        String hexId = new String(asset("windows/windows-document-id.txt"),
            StandardCharsets.US_ASCII).trim();
        assertEquals(32, hexId.length());
        byte[] expectedId = new byte[16];
        for (int i = 0; i < expectedId.length; i++) {
            int high = Character.digit(hexId.charAt(i * 2), 16);
            int low = Character.digit(hexId.charAt(i * 2 + 1), 16);
            assertTrue(high >= 0 && low >= 0);
            expectedId[i] = (byte)((high << 4) | low);
        }
        byte[] password = utf8("0b4e79c5-7cfe-4b7c-b4f3-d89129cb7b5e");
        NativeCore.Result context = NativeCore.nativeCreateContext();
        assertEquals(NativeCore.OK, context.status);
        try {
            assertEquals(NativeCore.OK, NativeCore.nativeOpen(context.handle, encrypted).status);
            assertEquals(NativeCore.AUTHENTICATION_FAILED,
                NativeCore.nativeUnlock(context.handle, utf8("incorrect password")).status);
            assertEquals(NativeCore.OK,
                NativeCore.nativeUnlock(context.handle, password).status);
            NativeCore.Result read = NativeCore.nativeRead(context.handle);
            assertEquals(NativeCore.OK, read.status);
            assertArrayEquals(utf8("alpha\n"), read.data);
            assertArrayEquals(expectedId, read.documentId);
            Arrays.fill(read.data, (byte)0);
        } finally {
            Arrays.fill(password, (byte)0);
            assertEquals(NativeCore.OK,
                NativeCore.nativeCloseContext(context.handle).status);
        }
        assertEquals(0, NativeCore.nativeActiveContextCount());
    }

    @Test public void rejectsMalformedAndReusesContext() throws Exception {
        byte[] encrypted = fixture("valid/baseline-container.hex");
        encrypted[0] = 0;
        NativeCore.Result context = NativeCore.nativeCreateContext();
        assertEquals(NativeCore.OK, context.status);
        try {
            assertEquals(NativeCore.MALFORMED_CONTAINER,
                NativeCore.nativeOpen(context.handle, encrypted).status);
            assertEquals(NativeCore.INVALID_STATE,
                NativeCore.nativeRead(context.handle).status);
            encrypted[0] = 'S';
            assertEquals(NativeCore.OK,
                NativeCore.nativeOpen(context.handle, encrypted).status);
            assertEquals(NativeCore.OK,
                NativeCore.nativeCloseContainer(context.handle).status);
        } finally {
            assertEquals(NativeCore.OK,
                NativeCore.nativeCloseContext(context.handle).status);
        }
        assertEquals(0, NativeCore.nativeActiveContextCount());
    }

    @Test public void repeatedlyCreatesAndClosesDocuments() {
        byte[] password = utf8("0b4e79c5-7cfe-4b7c-b4f3-d89129cb7b5e");
        for (int i = 0; i < 20; i++) {
            NativeCore.Result context = NativeCore.nativeCreateContext();
            assertEquals(NativeCore.OK, context.status);
            try {
                NativeCore.Result created = NativeCore.nativeCreateDocument(context.handle,
                    utf8("Ada"), utf8("ada@example.org"), utf8("Android"),
                    utf8("first line"), 123, password, null, 0);
                assertEquals(NativeCore.OK, created.status);
                assertEquals(NativeCore.INVALID_STATE, NativeCore.nativeCreateDocument(
                    context.handle, utf8("Ada"), utf8("ada@example.org"),
                    utf8("Android"), utf8("another line"), 124, password, null, 0).status);
                NativeCore.Result encrypted = NativeCore.nativeCopyEncrypted(context.handle);
                assertEquals(NativeCore.OK, encrypted.status);
                assertTrue(encrypted.data.length > 0);
                NativeCore.Result read = NativeCore.nativeRead(context.handle);
                assertEquals(NativeCore.OK, read.status);
                assertArrayEquals(utf8("first line"), read.data);
                Arrays.fill(read.data, (byte)0);
                assertEquals(NativeCore.OK,
                    NativeCore.nativeCloseContainer(context.handle).status);
            } finally {
                assertEquals(NativeCore.OK,
                    NativeCore.nativeCloseContext(context.handle).status);
            }
            assertEquals(0, NativeCore.nativeActiveContextCount());
        }
        Arrays.fill(password, (byte)0);
    }
}
