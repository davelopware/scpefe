package org.scpefe.nativecore;

import android.database.Cursor;
import android.database.MatrixCursor;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.DocumentsProvider;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/** Debug-only local document provider for emulator storage verification. */
public final class TestDocumentsProvider extends DocumentsProvider {
    public static final String AUTHORITY = "org.scpefe.nativecore.smoke.test.documents";
    public static final String ROOT_ID = "root";
    public static final String DOCUMENT_ID = "fixture";
    public static final String VIEW_ONLY_ID = "reader-fixture";

    @Override public boolean onCreate() {
        try {
            seed(DOCUMENT_ID, "windows/windows-container.bin");
            seed(VIEW_ONLY_ID, "vectors/multi-slot-container.hex");
            return true;
        } catch (IOException error) {
            throw new IllegalStateException("Android fixture unavailable to test provider", error);
        }
    }

    private void seed(String id, String asset) throws IOException {
        try (InputStream input = getContext().getAssets().open(asset);
                OutputStream output = new FileOutputStream(file(id))) {
            byte[] chunk = new byte[8192];
            if (!asset.endsWith(".hex")) {
                for (int count; (count = input.read(chunk)) != -1;)
                    output.write(chunk, 0, count);
                return;
            }
            ByteArrayOutputStream encoded = new ByteArrayOutputStream();
            for (int count; (count = input.read(chunk)) != -1;)
                encoded.write(chunk, 0, count);
            String hex = new String(encoded.toByteArray(), StandardCharsets.US_ASCII)
                .replaceAll("(?m)^#.*$", "").replaceAll("\\s", "");
            if ((hex.length() & 1) != 0) throw new IOException("invalid hex fixture");
            for (int index = 0; index < hex.length(); index += 2) {
                int high = Character.digit(hex.charAt(index), 16);
                int low = Character.digit(hex.charAt(index + 1), 16);
                if (high < 0 || low < 0) throw new IOException("invalid hex fixture");
                output.write((high << 4) | low);
            }
        }
    }

    @Override public Cursor queryRoots(String[] projection) {
        String[] columns = projection == null ? new String[] {
            DocumentsContract.Root.COLUMN_ROOT_ID,
            DocumentsContract.Root.COLUMN_DOCUMENT_ID,
            DocumentsContract.Root.COLUMN_TITLE,
            DocumentsContract.Root.COLUMN_FLAGS } : projection;
        MatrixCursor result = new MatrixCursor(columns);
        MatrixCursor.RowBuilder row = result.newRow();
        for (String column : columns) {
            if (column.equals(DocumentsContract.Root.COLUMN_ROOT_ID)) row.add("test-root");
            else if (column.equals(DocumentsContract.Root.COLUMN_DOCUMENT_ID)) row.add(ROOT_ID);
            else if (column.equals(DocumentsContract.Root.COLUMN_TITLE)) row.add("SCPEFE test provider");
            else if (column.equals(DocumentsContract.Root.COLUMN_FLAGS))
                row.add(DocumentsContract.Root.FLAG_LOCAL_ONLY
                    | DocumentsContract.Root.FLAG_SUPPORTS_CREATE);
            else row.add(0);
        }
        return result;
    }

    @Override public Cursor queryDocument(String documentId, String[] projection)
            throws FileNotFoundException {
        if (!ROOT_ID.equals(documentId) && !file(documentId).isFile())
            throw new FileNotFoundException(documentId);
        String[] columns = projection == null ? new String[] {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_FLAGS,
            DocumentsContract.Document.COLUMN_SIZE } : projection;
        MatrixCursor result = new MatrixCursor(columns);
        addDocumentRow(result, columns, documentId);
        return result;
    }

    private void addDocumentRow(MatrixCursor result, String[] columns, String documentId) {
        MatrixCursor.RowBuilder row = result.newRow();
        for (String column : columns) {
            if (column.equals(DocumentsContract.Document.COLUMN_DOCUMENT_ID)) row.add(documentId);
            else if (column.equals(DocumentsContract.Document.COLUMN_DISPLAY_NAME))
                row.add(ROOT_ID.equals(documentId) ? "SCPEFE test provider"
                    : DOCUMENT_ID.equals(documentId) ? "test.scpefe" : documentId + ".scpefe");
            else if (column.equals(DocumentsContract.Document.COLUMN_MIME_TYPE))
                row.add(ROOT_ID.equals(documentId)
                    ? DocumentsContract.Document.MIME_TYPE_DIR : "application/octet-stream");
            else if (column.equals(DocumentsContract.Document.COLUMN_FLAGS))
                row.add(ROOT_ID.equals(documentId)
                    ? DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE
                    : DocumentsContract.Document.FLAG_SUPPORTS_WRITE);
            else if (column.equals(DocumentsContract.Document.COLUMN_SIZE))
                row.add(ROOT_ID.equals(documentId) ? 0 : file(documentId).length());
            else row.add(null);
        }
    }

    @Override public Cursor queryChildDocuments(String parentDocumentId, String[] projection,
            String sortOrder) {
        String[] columns = projection == null ? new String[] {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_FLAGS } : projection;
        MatrixCursor result = new MatrixCursor(columns);
        if (ROOT_ID.equals(parentDocumentId)) {
            addDocumentRow(result, columns, DOCUMENT_ID);
            addDocumentRow(result, columns, VIEW_ONLY_ID);
            File[] children = getContext().getFilesDir().listFiles(
                (dir, name) -> name.startsWith("provider-created-") && name.endsWith(".scpefe"));
            if (children != null) for (File child : children) {
                String id = child.getName().substring("provider-".length(),
                    child.getName().length() - ".scpefe".length());
                addDocumentRow(result, columns, id);
            }
        }
        return result;
    }

    @Override public String createDocument(String parentDocumentId, String mimeType,
            String displayName) throws FileNotFoundException {
        if (!ROOT_ID.equals(parentDocumentId)) throw new FileNotFoundException(parentDocumentId);
        String id = "created-" + UUID.randomUUID();
        try {
            if (!file(id).createNewFile()) throw new IOException("already exists");
            return id;
        } catch (IOException error) { throw new FileNotFoundException("cannot create document"); }
    }

    @Override public ParcelFileDescriptor openDocument(String documentId, String mode,
            CancellationSignal signal) throws FileNotFoundException {
        if (!file(documentId).isFile()) throw new FileNotFoundException(documentId);
        return ParcelFileDescriptor.open(file(documentId), ParcelFileDescriptor.parseMode(mode));
    }

    private File file() { return file(DOCUMENT_ID); }

    private File file(String id) {
        if (!DOCUMENT_ID.equals(id) && !VIEW_ONLY_ID.equals(id)
                && !id.matches("created-[0-9a-f-]{36}"))
            return new File(getContext().getFilesDir(), "no-such-provider-document");
        return new File(getContext().getFilesDir(), "provider-" + id + ".scpefe");
    }
}
