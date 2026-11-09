package org.scpefe.nativecore;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import java.io.ByteArrayOutputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Arrays;
import java.util.Map;
import java.util.UUID;

/** Keeps SAF document URIs and grants behind stable opaque target references. */
public final class AndroidDocumentTargets implements TargetPublication.Store {
    private static final String PREFIX = "android-target:";
    private static final int MAX_BYTES = 33 * 1024 * 1024;
    private final Context context;
    private final ContentResolver resolver;
    private final SharedPreferences targets;
    private final TargetPublication publication;

    /** Outcome of a create rollback when a provider offers no conditional delete. */
    public enum CleanupOutcome { UNSUPPORTED, CHANGED, AMBIGUOUS }

    /** Opens app-private target metadata; the application disables Android backup. */
    public AndroidDocumentTargets(Context context) {
        this.context = context.getApplicationContext();
        resolver = this.context.getContentResolver();
        targets = this.context.getSharedPreferences("document-targets", Context.MODE_PRIVATE);
        publication = new TargetPublication(this);
    }

    /** Requests a new provider document without assuming a filesystem path. */
    public static Intent createPicker(String displayName) {
        if (displayName == null || displayName.isEmpty()) {
            throw new IllegalArgumentException("document name is required");
        }
        return new Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("application/octet-stream")
            .putExtra(Intent.EXTRA_TITLE, displayName)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
    }

    /** Requests a provider document with read and potential edit access. */
    public static Intent openPicker() {
        return new Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
    }

    /** Persists only picker-granted read/write access and returns a private target key. */
    public synchronized String registerPicked(Intent result) throws IOException {
        if (result == null || result.getData() == null
            || !DocumentsContract.isDocumentUri(context, result.getData())) {
            throw new IOException("picker did not return a document");
        }
        int modes = result.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION
            | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        if ((modes & Intent.FLAG_GRANT_READ_URI_PERMISSION) == 0) {
            throw new IOException("picker did not grant read access");
        }
        Uri uri = result.getData();
        try { resolver.takePersistableUriPermission(uri, modes); }
        catch (SecurityException error) {
            if ((modes & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) == 0) {
                throw new IOException("document grant is not persistent", error);
            }
            modes = Intent.FLAG_GRANT_READ_URI_PERMISSION;
            try { resolver.takePersistableUriPermission(uri, modes); }
            catch (SecurityException readError) {
                throw new IOException("document grant is not persistent", readError);
            }
        }
        boolean persisted = false;
        for (UriPermission grant : resolver.getPersistedUriPermissions()) {
            if (grant.getUri().equals(uri) && grant.isReadPermission()
                && ((modes & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) == 0
                    || grant.isWritePermission())) persisted = true;
        }
        if (!persisted) throw new IOException("document grant was not retained");
        for (Map.Entry<String, ?> item : targets.getAll().entrySet()) {
            if (item.getKey().startsWith(PREFIX) && uri.toString().equals(item.getValue())) {
                return item.getKey();
            }
        }
        String key = PREFIX + UUID.randomUUID();
        if (!targets.edit().putString(key, uri.toString()).commit()) {
            throw new IOException("could not retain document target");
        }
        return key;
    }

    /** Reports whether this adapter owns a reference without exposing its URI. */
    public boolean owns(String target) {
        return target != null && target.startsWith(PREFIX) && targets.contains(target);
    }

    /** Returns the four abilities required by the host target workflow. */
    public boolean[] capabilities() { return new boolean[] { true, true, true, true }; }

    /** Reads a complete encrypted container; provider disappearance is an I/O failure. */
    @Override public byte[] read(String target) throws IOException {
        Uri uri = uri(target);
        try (InputStream input = resolver.openInputStream(uri)) {
            if (input == null) throw new FileNotFoundException("document unavailable");
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            for (int count; (count = input.read(chunk)) != -1;) {
                if (count == 0) continue;
                if (output.size() > MAX_BYTES - count) throw new IOException("document too large");
                output.write(chunk, 0, count);
            }
            return output.toByteArray();
        } catch (SecurityException error) {
            throw new IOException("document permission unavailable", error);
        }
    }

    /** Checks granted write access and provider write support, without using metadata as freshness. */
    @Override public boolean canReplace(String target) throws IOException {
        Uri uri = uri(target);
        boolean writeGrant = false;
        for (UriPermission grant : resolver.getPersistedUriPermissions()) {
            if (grant.getUri().equals(uri) && grant.isWritePermission()) writeGrant = true;
        }
        if (!writeGrant) return false;
        try (Cursor cursor = resolver.query(uri,
                new String[] { DocumentsContract.Document.COLUMN_FLAGS }, null, null, null)) {
            if (cursor == null || !cursor.moveToFirst()) return false;
            return (cursor.getInt(0) & DocumentsContract.Document.FLAG_SUPPORTS_WRITE) != 0;
        } catch (SecurityException error) {
            throw new IOException("document permission unavailable", error);
        }
    }

    /** Attempts a best-effort provider write; the caller must reread exact bytes. */
    @Override public void replace(String target, byte[] candidate) throws IOException {
        if (candidate == null || candidate.length == 0 || candidate.length > MAX_BYTES) {
            throw new IllegalArgumentException("invalid candidate size");
        }
        Uri uri = uri(target);
        try (ParcelFileDescriptor descriptor = resolver.openFileDescriptor(uri, "rwt")) {
            if (descriptor == null) throw new FileNotFoundException("document unavailable");
            try (OutputStream output = new ParcelFileDescriptor.AutoCloseOutputStream(descriptor)) {
                output.write(candidate);
                output.flush();
            }
        } catch (SecurityException error) {
            throw new IOException("document permission unavailable", error);
        }
    }

    /** Creates a newly selected empty document and confirms exact initial bytes. */
    public TargetPublication.Outcome create(String target, byte[] candidate) {
        try {
            if (read(target).length != 0) return TargetPublication.Outcome.AMBIGUOUS;
        } catch (IOException error) { return TargetPublication.Outcome.AMBIGUOUS; }
        return publication.publish(target, new byte[0], candidate);
    }

    /** Publishes a journaled candidate against the previously authenticated bytes. */
    public TargetPublication.Outcome publish(String target, byte[] base, byte[] candidate) {
        return publication.publish(target, base, candidate);
    }

    /** Refuses to delete a created document without provider compare-and-delete. */
    public CleanupOutcome removeCreated(String target, byte[] expected) {
        if (expected == null || expected.length == 0) {
            throw new IllegalArgumentException("expected candidate is required");
        }
        try {
            return Arrays.equals(read(target), expected)
                ? CleanupOutcome.UNSUPPORTED : CleanupOutcome.CHANGED;
        } catch (IOException | SecurityException error) {
            return CleanupOutcome.AMBIGUOUS;
        }
    }

    /** Drops a retained grant when no target or pending work still needs it. */
    public synchronized void forget(String target) throws IOException {
        Uri uri = uri(target);
        int modes = 0;
        for (UriPermission grant : resolver.getPersistedUriPermissions()) {
            if (grant.getUri().equals(uri)) {
                if (grant.isReadPermission()) modes |= Intent.FLAG_GRANT_READ_URI_PERMISSION;
                if (grant.isWritePermission()) modes |= Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
            }
        }
        if (modes != 0) {
            try { resolver.releasePersistableUriPermission(uri, modes); }
            catch (SecurityException ignored) { /* The provider may already have revoked it. */ }
        }
        if (!targets.edit().remove(target).commit()) throw new IOException("could not forget target");
    }

    /** Resolves an adapter-owned key only within the Android host. */
    private Uri uri(String target) throws IOException {
        if (!owns(target)) throw new FileNotFoundException("unknown document target");
        return Uri.parse(targets.getString(target, ""));
    }
}
