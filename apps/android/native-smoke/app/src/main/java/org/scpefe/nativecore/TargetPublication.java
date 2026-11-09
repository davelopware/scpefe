package org.scpefe.nativecore;

import java.io.IOException;
import java.util.Arrays;

/** Coordinates exact candidate publication against an opaque document target. */
public final class TargetPublication {
    /** Provider operations; implementations must return fresh complete byte arrays. */
    public interface Store {
        byte[] read(String target) throws IOException;
        boolean canReplace(String target) throws IOException;
        void replace(String target, byte[] candidate) throws IOException;
    }

    /** A publication result for the host's journal and candidate protocol. */
    public enum Outcome { VERIFIED, DEFINITE_FAILURE, AMBIGUOUS }

    private final Store store;

    /** Binds publication to one provider-backed store. */
    public TargetPublication(Store store) { this.store = store; }

    /** Reads the exact target image, including on reconciliation. */
    public byte[] read(String target) throws IOException { return store.read(target); }

    /** Publishes only after comparing a fresh image with the authenticated base. */
    public Outcome publish(String target, byte[] base, byte[] candidate) {
        if (target == null || base == null || candidate == null || candidate.length == 0) {
            throw new IllegalArgumentException("target, base, and candidate are required");
        }
        byte[] before;
        try { before = store.read(target); }
        catch (IOException | SecurityException error) { return Outcome.AMBIGUOUS; }
        if (Arrays.equals(before, candidate)) return Outcome.VERIFIED;
        if (!Arrays.equals(before, base)) return Outcome.AMBIGUOUS;
        try {
            if (!store.canReplace(target)) return Outcome.DEFINITE_FAILURE;
        } catch (IOException | SecurityException error) { return Outcome.AMBIGUOUS; }
        try { store.replace(target, candidate); }
        catch (IOException | SecurityException error) { return verify(target, candidate); }
        return verify(target, candidate);
    }

    /** Confirms success only with a complete byte-for-byte reread. */
    private Outcome verify(String target, byte[] candidate) {
        try {
            return Arrays.equals(store.read(target), candidate)
                ? Outcome.VERIFIED : Outcome.AMBIGUOUS;
        } catch (IOException | SecurityException error) {
            return Outcome.AMBIGUOUS;
        }
    }
}
