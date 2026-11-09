package org.scpefe.nativecore;

import android.database.Cursor;
import android.database.MatrixCursor;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.DocumentsProvider;
import java.io.File;
import java.io.FileNotFoundException;

/** Debug-only local document provider for emulator storage verification. */
public final class TestDocumentsProvider extends DocumentsProvider {
    public static final String AUTHORITY = "org.scpefe.nativecore.smoke.test.documents";
    public static final String ROOT_ID = "root";
    public static final String DOCUMENT_ID = "fixture";

    @Override public boolean onCreate() { return true; }

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
                row.add(DocumentsContract.Root.FLAG_LOCAL_ONLY);
            else row.add(0);
        }
        return result;
    }

    @Override public Cursor queryDocument(String documentId, String[] projection)
            throws FileNotFoundException {
        if (!DOCUMENT_ID.equals(documentId) && !ROOT_ID.equals(documentId))
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
                row.add(ROOT_ID.equals(documentId) ? "SCPEFE test provider" : "test.scpefe");
            else if (column.equals(DocumentsContract.Document.COLUMN_MIME_TYPE))
                row.add(ROOT_ID.equals(documentId)
                    ? DocumentsContract.Document.MIME_TYPE_DIR : "application/octet-stream");
            else if (column.equals(DocumentsContract.Document.COLUMN_FLAGS))
                row.add(ROOT_ID.equals(documentId) ? 0
                    : DocumentsContract.Document.FLAG_SUPPORTS_WRITE);
            else if (column.equals(DocumentsContract.Document.COLUMN_SIZE))
                row.add(ROOT_ID.equals(documentId) ? 0 : file().length());
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
        if (ROOT_ID.equals(parentDocumentId)) addDocumentRow(result, columns, DOCUMENT_ID);
        return result;
    }

    @Override public ParcelFileDescriptor openDocument(String documentId, String mode,
            CancellationSignal signal) throws FileNotFoundException {
        if (!DOCUMENT_ID.equals(documentId)) throw new FileNotFoundException(documentId);
        return ParcelFileDescriptor.open(file(), ParcelFileDescriptor.parseMode(mode));
    }

    private File file() { return new File(getContext().getFilesDir(), "provider-fixture.scpefe"); }
}
