package org.scpefe.nativecore;

/** Thin, synchronous Java entry points for the versioned native C ABI. */
public final class NativeCore {
    static {
        System.loadLibrary("scpefe");
    }

    private NativeCore() {}

    /** One operation result; callers own and must clear returned cleartext data. */
    public static final class Result {
        public final int status;
        public final long handle;
        public final byte[] data;
        public final byte[] documentId;

        private Result(int status, long handle, byte[] data, byte[] documentId) {
            this.status = status;
            this.handle = handle;
            this.data = data;
            this.documentId = documentId;
        }
    }

    public static final int OK = 0;
    public static final int INVALID_STATE = 14;
    public static final int MALFORMED_CONTAINER = 9;
    public static final int AUTHENTICATION_FAILED = 10;
    public static final int LOCKED = 15;

    /** Owns one context until closeContext is called. */
    public static native Result nativeCreateContext();
    /** Releases the context and any still active container. */
    public static native Result nativeCloseContext(long handle);
    /** Reports live context owners for lifecycle smoke tests. */
    public static native int nativeActiveContextCount();
    /** Opens exact encrypted bytes in the core's locked state. */
    public static native Result nativeOpen(long handle, byte[] encrypted);
    /** Authenticates a transient password on the active container. */
    public static native Result nativeUnlock(long handle, byte[] password);
    /** Creates a document using exact UTF-8 byte arrays and the core's policy. */
    public static native Result nativeCreateDocument(long handle, byte[] name,
        byte[] email, byte[] device, byte[] content, long timestamp,
        byte[] ownerPassword, byte[] recoveryPassword, int contentType);
    /** Copies the current encrypted container for exact provider publication. */
    public static native Result nativeCopyEncrypted(long handle);
    /** Returns the core's stable proposed-password policy code. */
    public static native int nativeAssessPassword(byte[] password);
    /** Reports authenticated Plain Text or CSV content type for the active container. */
    public static native int nativeContentType(long handle);
    /** Copies authenticated text and document ID into owned Java arrays. */
    public static native Result nativeRead(long handle);
    /** Copies the core-derived journal key; the caller must erase the returned array. */
    public static native Result nativeJournalKey(long handle);
    /** Closes the active container while retaining its context. */
    public static native Result nativeCloseContainer(long handle);
}
