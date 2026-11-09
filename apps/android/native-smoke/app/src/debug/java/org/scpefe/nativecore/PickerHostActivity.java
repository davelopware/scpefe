package org.scpefe.nativecore;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.DocumentsContract;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/** Debug-only activity that obtains a genuine system document-picker result. */
public final class PickerHostActivity extends Activity {
    private static final LinkedBlockingQueue<Intent> RESULTS = new LinkedBlockingQueue<>();

    /** Clears any result left by a prior instrumented run. */
    public static void clearResults() { RESULTS.clear(); }

    /** Waits for the system picker to return a selected document. */
    public static Intent awaitResult(long timeoutMs) throws InterruptedException {
        return RESULTS.poll(timeoutMs, TimeUnit.MILLISECONDS);
    }

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        Intent picker = AndroidDocumentTargets.openPicker();
        Uri initial = getIntent().getParcelableExtra(DocumentsContract.EXTRA_INITIAL_URI);
        if (initial != null) picker.putExtra(DocumentsContract.EXTRA_INITIAL_URI, initial);
        startActivityForResult(picker, 1);
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == 1) {
            RESULTS.offer(result == RESULT_OK ? data : new Intent());
            finish();
        }
    }
}
