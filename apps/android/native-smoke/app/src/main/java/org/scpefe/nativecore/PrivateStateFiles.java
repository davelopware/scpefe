package org.scpefe.nativecore;

import android.content.Context;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.StandardCopyOption;
import java.security.SecureRandom;

/** Writes app-private records without replacing a recoverable record on failure. */
final class PrivateStateFiles {
    /** Optional test hook for an interrupted replacement. */
    interface BeforeReplace { void run() throws IOException; }

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final long MIB = 1024L * 1024L;
    private final File directory;
    private final BeforeReplace beforeReplace;
    private final long maxRecordBytes;
    private final long maxDirectoryBytes;
    private final long freeSpaceReserve;

    PrivateStateFiles(Context context, String subdirectory) {
        this(new File(context.getFilesDir(), subdirectory), () -> {},
            "work-journals".equals(subdirectory) ? 160 * MIB : MIB,
            "work-journals".equals(subdirectory) ? 512 * MIB : 4 * MIB,
            16 * MIB);
    }

    PrivateStateFiles(File directory, BeforeReplace beforeReplace) {
        this(directory, beforeReplace, 160 * MIB, 512 * MIB, 16 * MIB);
    }

    PrivateStateFiles(File directory, BeforeReplace beforeReplace,
            long maxRecordBytes, long maxDirectoryBytes, long freeSpaceReserve) {
        this.directory = directory;
        this.beforeReplace = beforeReplace;
        this.maxRecordBytes = maxRecordBytes;
        this.maxDirectoryBytes = maxDirectoryBytes;
        this.freeSpaceReserve = freeSpaceReserve;
    }

    File file(String name) {
        if (name == null || !name.matches("[a-zA-Z0-9._-]+")
                || name.startsWith(".")) throw new IllegalArgumentException("invalid record name");
        return new File(directory, name);
    }

    byte[] read(String name) throws IOException {
        File target = file(name);
        if (target.exists() && target.length() > maxRecordBytes)
            throw new IOException("private state record exceeds quota");
        try { return Files.readAllBytes(target.toPath()); }
        catch (NoSuchFileException missing) { return null; }
    }

    void write(String name, byte[] data) throws IOException {
        if (data == null) throw new IllegalArgumentException("record is required");
        if (!directory.isDirectory() && !directory.mkdirs()) {
            throw new IOException("private state directory unavailable");
        }
        File target = file(name);
        if (data.length > maxRecordBytes)
            throw new IOException("private state record exceeds quota");
        File[] records = directory.listFiles();
        if (records == null) throw new IOException("private state directory unavailable");
        long used = 0;
        for (File record : records) {
            if (record.isFile() && !record.equals(target)) {
                used += record.length();
                if (used > maxDirectoryBytes) break;
            }
        }
        if (used > maxDirectoryBytes - data.length)
            throw new IOException("private state directory exceeds quota");
        long available = directory.getUsableSpace();
        if (available < freeSpaceReserve
                || data.length > available - freeSpaceReserve)
            throw new IOException("insufficient private storage for recovery checkpoint");
        byte[] suffix = new byte[8];
        RANDOM.nextBytes(suffix);
        StringBuilder hex = new StringBuilder();
        for (byte value : suffix) hex.append(String.format("%02x", value & 0xff));
        File temporary = new File(directory, "." + name + ".tmp-" + hex);
        try {
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                output.write(data);
                output.getFD().sync();
            }
            beforeReplace.run();
            try {
                Files.move(temporary.toPath(), target.toPath(),
                    StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException error) {
                throw new IOException("private state atomic replacement unavailable", error);
            }
        } finally {
            if (temporary.exists() && !temporary.delete()) {
                // An orphaned temporary file is never treated as the current record.
            }
        }
    }
}
