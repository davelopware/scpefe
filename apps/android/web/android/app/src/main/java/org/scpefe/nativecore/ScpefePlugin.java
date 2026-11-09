package org.scpefe.nativecore;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/** Narrow, serial Capacitor bridge for document admission and local editing. */
@CapacitorPlugin(name = "Scpefe")
public final class ScpefePlugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService clock = Executors.newSingleThreadScheduledExecutor();
    private AndroidSessionController session;
    private volatile boolean createPicker;

    @Override public void load() {
        session = new AndroidSessionController(getContext());
        clock.scheduleAtFixedRate(() -> {
            try {
                worker.execute(() -> {
                    try {
                        JSONObject saved = session.regularSaveIfDue(System.currentTimeMillis());
                        if (saved != null) notifyListeners("regularSave", new JSObject()
                            .put("published", true).put("provisional", true)
                            .put("content", saved.optString("content"))
                            .put("journalScope", saved.optString("journalScope"))
                            .put("revision", saved.optLong("revision")));
                    } catch (AndroidSessionController.Failure error) {
                        notifyListeners("journalWarning", new JSObject()
                            .put("code", error.code));
                    }
                });
            } catch (RejectedExecutionException ignored) {
                // Activity teardown already stopped the serial native worker.
            }
        }, 5, 5, TimeUnit.SECONDS);
    }

    @Override protected void handleOnDestroy() {
        session.replaceGeneration();
        clock.shutdownNow();
        worker.execute(() -> session.closeNow());
        worker.shutdown();
        super.handleOnDestroy();
    }

    private interface Work { JSObject run() throws Exception; }

    /** Dispatches native and private-storage work off the Android UI thread. */
    private void dispatch(PluginCall call, Work work) {
        worker.execute(() -> {
            try { call.resolve(work.run()); }
            catch (AndroidSessionController.Failure error) {
                call.reject(error.getMessage(), error.code);
            } catch (IOException error) {
                call.reject("App-private state is unavailable.", "PRIVATE_STATE_UNAVAILABLE");
            } catch (Exception error) {
                call.reject("Document operation failed.", "OPERATION_FAILED");
            }
        });
    }

    @PluginMethod public void getProfile(PluginCall call) {
        dispatch(call, () -> {
            JSONObject profile = session.profile();
            return new JSObject().put("profile", profile == null ? JSONObject.NULL : profile);
        });
    }

    @PluginMethod public void saveProfile(PluginCall call) {
        dispatch(call, () -> new JSObject().put("profile",
            session.saveProfile(call.getObject("profile"))));
    }

    @PluginMethod public void getClientSettings(PluginCall call) {
        dispatch(call, () -> new JSObject().put("settings", session.settings()));
    }

    @PluginMethod public void saveClientSettings(PluginCall call) {
        dispatch(call, () -> new JSObject().put("settings",
            session.saveSettings(call.getObject("settings"))));
    }

    @PluginMethod public void assessPasswordPolicy(PluginCall call) {
        dispatch(call, () -> new JSObject().put("assessment",
            session.assessPassword(call.getString("password"))));
    }

    @PluginMethod public void chooseCreateTarget(PluginCall call) {
        session.replaceGeneration();
        createPicker = true;
        startActivityForResult(call,
            AndroidDocumentTargets.createPicker("Untitled.scpefe"), "pickedTarget");
    }

    @PluginMethod public void chooseOpenTarget(PluginCall call) {
        session.replaceGeneration();
        createPicker = false;
        startActivityForResult(call, AndroidDocumentTargets.openPicker(), "pickedTarget");
    }

    @ActivityCallback private void pickedTarget(PluginCall call,
            androidx.activity.result.ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.resolve(new JSObject().put("selected", false));
            return;
        }
        final Intent picked = result.getData();
        final boolean creating = createPicker;
        final long expected = session.generation();
        dispatch(call, () -> {
            session.requireCurrent(expected);
            String target = session.targets().registerPicked(picked);
            session.selected(target);
            return new JSObject().put("selected", true)
                .put("name", creating ? "Untitled.scpefe" : "Selected document");
        });
    }

    @PluginMethod public void cancelCreateTarget(PluginCall call) {
        session.replaceGeneration();
        dispatch(call, () -> { session.clearSelection(); return new JSObject(); });
    }

    @PluginMethod public void cancelOpenTarget(PluginCall call) {
        session.replaceGeneration();
        dispatch(call, () -> { session.clearSelection(); return new JSObject(); });
    }

    @PluginMethod public void createDocument(PluginCall call) {
        final long expected = session.generation();
        JSONObject request = call.getObject("request");
        if (request == null || request.toString().length() > 20_000) {
            call.reject("Invalid creation request.", "INVALID_ARGUMENT"); return;
        }
        dispatch(call, () -> new JSObject().put("opened", session.create(request, expected))
            .put("created", true).put("name", "Untitled.scpefe"));
    }

    @PluginMethod public void openSelectedDocument(PluginCall call) {
        final long expected = session.generation();
        dispatch(call, () -> new JSObject().put("opened",
            session.open(call.getString("password"), expected)));
    }

    @PluginMethod public void unlockDocument(PluginCall call) {
        final long expected = session.generation();
        final Integer delay = call.getInt("debugDelayMs");
        if (delay != null && (delay < 0 || delay > 5000 || (getContext()
                .getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0)) {
            call.reject("Invalid debug delay.", "INVALID_ARGUMENT"); return;
        }
        dispatch(call, () -> {
            if (delay != null) Thread.sleep(delay);
            return new JSObject().put("opened",
                session.unlock(call.getString("password"), expected));
        });
    }

    @PluginMethod public void lock(PluginCall call) {
        session.replaceGeneration();
        dispatch(call, () -> { session.lockNow(); return new JSObject().put("locked", true)
            .put("journalSaved", true).put("warningCode", JSONObject.NULL); });
    }

    @PluginMethod public void closeDocument(PluginCall call) {
        session.replaceGeneration();
        dispatch(call, () -> { session.closeNow(); return new JSObject().put("closed", true); });
    }

    @PluginMethod public void getUnresolvedJournalSummary(PluginCall call) {
        dispatch(call, () -> new JSObject()
            .put("total", session.unresolvedJournalCount())
            .put("pendingPublications", session.unresolvedJournalCount()));
    }

    @PluginMethod public void enterEditMode(PluginCall call) {
        final long expected = session.generation();
        dispatch(call, () -> new JSObject().put("opened", session.enterEdit(expected)));
    }

    @PluginMethod public void restoreRecoveredWork(PluginCall call) {
        final long expected = session.generation();
        dispatch(call, () -> new JSObject().put("opened", session.restoreRecovered(expected)));
    }

    @PluginMethod public void updateWorkingCopy(PluginCall call) {
        final long expected = session.generation();
        JSONObject update = call.getObject("update");
        if (update == null || update.toString().length() > 2 * 1024 * 1024) {
            call.reject("Invalid working copy.", "INVALID_ARGUMENT"); return;
        }
        dispatch(call, () -> { session.updateWorkingCopy(update, expected);
            return new JSObject().put("accepted", true); });
    }

    @PluginMethod public void saveDocument(PluginCall call) {
        final long expected = session.generation();
        JSONObject request = call.getObject("request");
        if (request == null || request.toString().length() > 2 * 1024 * 1024) {
            call.reject("Invalid save request.", "INVALID_ARGUMENT"); return;
        }
        dispatch(call, () -> new JSObject().put("result",
            session.save(request, true, expected)));
    }

    @PluginMethod public void reconnectPendingPublication(PluginCall call) {
        final long expected = session.generation();
        dispatch(call, () -> new JSObject().put("result",
            session.reconnectPending(expected)));
    }
}
