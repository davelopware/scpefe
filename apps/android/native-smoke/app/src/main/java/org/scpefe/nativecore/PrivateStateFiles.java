package org.scpefe.nativecore;

import android.content.Context;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.SecureRandom;

/** Writes app-private records without replacing a recoverable record on failure. */
final class PrivateStateFiles {
    /** Optional test hook for an interrupted replacement. */
    interface BeforeReplace { void run() throws IOException; }

    private static final SecureRandom RANDOM = new SecureRandom();
    private final File directory;
    private final BeforeReplace beforeReplace;

    PrivateStateFiles(Context context, String subdirectory) {
        this(new File(context.getFilesDir(), subdirectory), () -> {});
    }

    PrivateStateFiles(File directory, BeforeReplace beforeReplace) {
        this.directory = directory;
        this.beforeReplace = beforeReplace;
    }

    File file(String name) {
        if (name == null || !name.matches("[a-zA-Z0-9._-]+")
                || name.startsWith(".")) throw new IllegalArgumentException("invalid record name");
        return new File(directory, name);
    }

    byte[] read(String name) throws IOException {
        File target = file(name);
        return target.exists() ? Files.readAllBytes(target.toPath()) : null;
    }

    void write(String name, byte[] data) throws IOException {
        if (data == null) throw new IllegalArgumentException("record is required");
        if (!directory.isDirectory() && !directory.mkdirs()) {
            throw new IOException("private state directory unavailable");
        }
        File target = file(name);
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
