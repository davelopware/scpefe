package org.scpefe.nativecore;

import static org.junit.Assert.*;

import android.os.SystemClock;
import android.content.Context;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.os.ParcelFileDescriptor;
import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.StaleObjectException;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.Until;
import java.util.concurrent.CountDownLatch;
import java.io.File;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.Arrays;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.scpefe.nativecore.smoke.MainActivity;

/** Drives the real Capacitor WebView and Android picker against a local provider. */
@RunWith(AndroidJUnit4.class)
public final class WebViewWorkflowInstrumentedTest {
    private static final String APP_PACKAGE = "org.scpefe.nativecore.smoke";
    private static final String OWNER = "0b4e79c5-7cfe-4b7c-b4f3-d89129cb7b5e";
    private static final String WINDOWS = OWNER;

    private static String eval(ActivityScenario<MainActivity> scenario, String script)
            throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        scenario.onActivity(activity -> {
            WebView web = activity.getBridge().getWebView();
            web.evaluateJavascript(script, value -> { result.set(value); latch.countDown(); });
        });
        assertTrue("WebView did not answer", latch.await(15, TimeUnit.SECONDS));
        return result.get();
    }

    private static void until(ActivityScenario<MainActivity> scenario, String condition,
            long timeoutMs) throws Exception {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        while (SystemClock.uptimeMillis() < deadline) {
            if ("true".equals(eval(scenario, "Boolean(" + condition + ")"))) return;
            SystemClock.sleep(100);
        }
        String state = eval(scenario, "JSON.stringify({document:document.querySelector("
            + "'[aria-label=\"Document state\"]')?.textContent,"
            + "alert:document.querySelector('[role=alert]')?.textContent,"
            + "editDisabled:document.querySelector('[aria-label=\"Edit document contents\"]')"
            + "?.disabled,menu:[...document.querySelectorAll('[role=menu] button')]"
            + ".map(x=>[x.querySelector('span')?.textContent.trim(),x.disabled])})");
        fail("WebView condition did not become true: " + condition + "; state=" + state);
    }

    private static void menu(ActivityScenario<MainActivity> scenario, String menu,
            String action) throws Exception {
        eval(scenario, "document.querySelector('[aria-label=\"" + menu
            + "\"][aria-haspopup=\"menu\"]').click()");
        until(scenario, "[...document.querySelectorAll('[role=menu] button')]"
            + ".some(x=>x.querySelector('span')?.textContent.trim()==='" + action
            + "'&&!x.disabled)", 10_000);
        eval(scenario, "[...document.querySelectorAll('[role=menu] button')]"
            + ".find(x=>x.querySelector('span')?.textContent.trim()==='" + action
            + "').click()");
    }

    private static void click(UiDevice device, Pattern label) {
        long deadline = SystemClock.uptimeMillis() + 10_000;
        while (SystemClock.uptimeMillis() < deadline) {
            UiObject2 item = device.wait(Until.findObject(By.text(label)), 1_000);
            if (item == null) continue;
            try {
                item.click();
                return;
            } catch (StaleObjectException ignored) {
                // DocumentsUI rebuilt its row; reacquire the live accessibility node.
            }
        }
        fail("Picker item missing or stale: " + label);
    }

    private static void provider(UiDevice device) {
        long deadline = SystemClock.uptimeMillis() + 15_000;
        while (SystemClock.uptimeMillis() < deadline) {
            if (device.hasObject(By.text("SCPEFE test provider"))
                    && device.hasObject(By.text("test.scpefe"))) return;
            UiObject2 roots = device.wait(Until.findObject(By.descContains("Show roots")), 1_000);
            if (roots != null) {
                try { roots.click(); }
                catch (StaleObjectException ignored) { continue; }
            }
            UiObject2 root = device.wait(
                Until.findObject(By.text("SCPEFE test provider")), 1_000);
            if (root == null) continue;
            try { root.click(); }
            catch (StaleObjectException ignored) { continue; }
            device.wait(Until.hasObject(By.text("test.scpefe")), 2_000);
        }
        fail("System picker did not enter the test provider destination");
    }

    private static void finishOpenPicker(ActivityScenario<MainActivity> scenario,
            UiDevice device) throws Exception {
        long deadline = SystemClock.uptimeMillis() + 15_000;
        while (SystemClock.uptimeMillis() < deadline) {
            if (APP_PACKAGE.equals(device.getCurrentPackageName())) {
                until(scenario, "document.querySelector('input[name=password]')", 10_000);
                return;
            }
            UiObject2 open = device.wait(Until.findObject(
                By.text(Pattern.compile("(?i)^open$"))), 1_000);
            if (open == null) continue;
            try { open.click(); }
            catch (StaleObjectException ignored) {
                // The picker changed while selecting; the next loop checks its live state.
            }
        }
        fail("System picker neither returned a document nor offered Open");
    }

    private static void setInput(ActivityScenario<MainActivity> scenario, String name,
            String value) throws Exception {
        eval(scenario, "(()=>{const e=document.querySelector('input[name=\"" + name
            + "\"]');if(!e)return false;Object.getOwnPropertyDescriptor("
            + "HTMLInputElement.prototype,'value').set.call(e,'" + value + "');"
            + "e.dispatchEvent(new Event('input',{bubbles:true}));return true})()");
    }

    private static void ensureProfile(ActivityScenario<MainActivity> scenario)
            throws Exception {
        until(scenario, "document.querySelector('input[name=name]')"
            + "||document.querySelector('[aria-label=\"File\"]')", 15_000);
        long deadline = SystemClock.uptimeMillis() + 20_000;
        while (SystemClock.uptimeMillis() < deadline) {
            if ("true".equals(eval(scenario,
                    "Boolean(document.querySelector('input[name=name]'))"))) {
                setInput(scenario, "name", "Ada");
                setInput(scenario, "email", "ada@example.org");
                setInput(scenario, "deviceName", "Android emulator");
                eval(scenario, "document.querySelector('input[name=name]').form.requestSubmit()");
                until(scenario, "!document.querySelector('input[name=name]')", 10_000);
            }
            if ("true".equals(eval(scenario, "Boolean([...document.querySelectorAll"
                    + "('[role=menu] button')].some(x=>x.querySelector('span')"
                    + "?.textContent.trim()==='New'&&!x.disabled))"))) {
                eval(scenario, "document.querySelector('[aria-label=\"File\"]"
                    + "[aria-expanded=true]')?.click()");
                until(scenario, "!document.querySelector('[role=menu][aria-label=\"File\"]')",
                    5_000);
                return;
            }
            eval(scenario, "if(!document.querySelector('[role=menu][aria-label=\"File\"]'))"
                + "document.querySelector('[aria-label=\"File\"]')?.click()");
            SystemClock.sleep(100);
        }
        fail("Profile did not reach an enabled File > New command");
    }

    private static void setDocumentText(ActivityScenario<MainActivity> scenario,
            String value) throws Exception {
        String escaped = org.json.JSONObject.quote(value);
        assertEquals("true", eval(scenario, "(()=>{const e=document.querySelector("
            + "'textarea[aria-label=\"Document text\"]');if(!e||e.readOnly)return false;"
            + "Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')"
            + ".set.call(e," + escaped + ");"
            + "e.dispatchEvent(new Event('input',{bubbles:true}));return true})()"));
    }

    private static void chooseFixture(ActivityScenario<MainActivity> scenario,
            UiDevice device, String name) throws Exception {
        menu(scenario, "File", "Open…");
        provider(device);
        click(device, Pattern.compile(Pattern.quote(name)));
        finishOpenPicker(scenario, device);
    }

    private static void unlockSelected(ActivityScenario<MainActivity> scenario,
            String password) throws Exception {
        setInput(scenario, "password", password);
        eval(scenario, "document.querySelector('input[name=password]').form.requestSubmit()");
        until(scenario, "!document.querySelector('input[name=password]')"
            + "&&document.querySelector('textarea[aria-label=\"Document text\"]')",
            20_000);
    }

    private static void openFixture(ActivityScenario<MainActivity> scenario,
            UiDevice device, String name, String password) throws Exception {
        chooseFixture(scenario, device, name);
        unlockSelected(scenario, password);
    }

    private static void openFixture(ActivityScenario<MainActivity> scenario,
            UiDevice device) throws Exception {
        openFixture(scenario, device, "test.scpefe", WINDOWS);
    }

    private static byte[] readAll(InputStream input) throws Exception {
        try (InputStream source = input; java.io.ByteArrayOutputStream output =
                new java.io.ByteArrayOutputStream()) {
            byte[] chunk = new byte[8192];
            for (int count; (count = source.read(chunk)) != -1;) {
                output.write(chunk, 0, count);
            }
            return output.toByteArray();
        }
    }

    private static Uri fixtureUri(String id) {
        return DocumentsContract.buildDocumentUri(TestDocumentsProvider.AUTHORITY, id);
    }

    private static byte[] readProvider(Context context, String id) throws Exception {
        InputStream input = context.getContentResolver().openInputStream(fixtureUri(id));
        assertNotNull("SAF grant did not permit provider read", input);
        return readAll(input);
    }

    private static void replaceProvider(Context context, String id, byte[] content)
            throws Exception {
        ParcelFileDescriptor descriptor = context.getContentResolver()
            .openFileDescriptor(fixtureUri(id), "rwt");
        assertNotNull("SAF grant did not permit provider write", descriptor);
        try (java.io.OutputStream output = new ParcelFileDescriptor
                .AutoCloseOutputStream(descriptor)) {
            output.write(content);
            output.flush();
        }
    }

    private static void waitForChange(Context context, String id, byte[] before)
            throws Exception {
        long deadline = SystemClock.uptimeMillis() + 15_000;
        while (SystemClock.uptimeMillis() < deadline) {
            if (!Arrays.equals(before, readProvider(context, id))) return;
            SystemClock.sleep(50);
        }
        fail("Native lease release did not finish before restart");
    }

    private static void waitForStableJournal(File journal) throws Exception {
        long deadline = SystemClock.uptimeMillis() + 15_000;
        while (SystemClock.uptimeMillis() < deadline) {
            if (journal.isFile() && !new String(Files.readAllBytes(journal.toPath()),
                    StandardCharsets.UTF_8)
                    .contains("bootstrap")) return;
            SystemClock.sleep(50);
        }
        fail("Lease release did not restore the encrypted unsaved journal");
    }

    @After public void dismissPickerAfterFailure() {
        UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
        for (int attempt = 0; attempt < 4; attempt++) {
            String foreground = device.getCurrentPackageName();
            if (foreground == null || !foreground.contains("documentsui")) return;
            device.pressBack();
        }
    }

    @Test public void viewOnlySlotCannotAcquireNativeLease() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            ensureProfile(scenario);
            UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
            openFixture(scenario, device, "reader-fixture.scpefe",
                "reader test password");
            assertEquals("true", eval(scenario,
                "document.querySelector('[aria-label=\"Edit document contents\"]').disabled"));
            eval(scenario, "window.__denied='pending';"
                + "window.Capacitor.Plugins.Scpefe.enterEditMode()"
                + ".then(()=>window.__denied='unexpected')"
                + ".catch(e=>window.__denied=e.code)");
            until(scenario, "window.__denied!=='pending'", 10_000);
            assertEquals("\"EDIT_DENIED\"", eval(scenario, "window.__denied"));
        }
    }

    @Test public void editCheckpointRestartRecoveryAndChangedTarget() throws Exception {
        Context target = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Context test = InstrumentationRegistry.getInstrumentation().getContext();
        String documentId = new String(readAll(test.getAssets().open(
            "windows/windows-document-id.txt")), StandardCharsets.UTF_8).trim();
        File journalDirectory = new File(target.getFilesDir(), "work-journals");
        File journal = new File(journalDirectory, documentId + ".work-journal");
        Files.deleteIfExists(journal.toPath());
        byte[] original = readAll(test.getAssets().open("windows/windows-container.bin"));
        boolean fixtureSelected = false;
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            ensureProfile(scenario);
            UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
            chooseFixture(scenario, device, "test.scpefe");
            fixtureSelected = true;
            replaceProvider(target, TestDocumentsProvider.DOCUMENT_ID, original);
            unlockSelected(scenario, WINDOWS);
            until(scenario, "document.querySelector('textarea[aria-label=\"Document text\"]')"
                + ".value==='alpha\\n'", 20_000);
            assertEquals("\"alpha\\n\"", eval(scenario,
                "document.querySelector('textarea[aria-label=\"Document text\"]').value"));
            until(scenario, "!document.querySelector('textarea[aria-label=\"Document text\"]')"
                + ".readOnly||!document.querySelector('[aria-label=\"Edit document contents\"]')"
                + ".disabled", 15_000);
            if ("true".equals(eval(scenario,
                    "document.querySelector('textarea[aria-label=\"Document text\"]').readOnly"))) {
                eval(scenario,
                    "document.querySelector('[aria-label=\"Edit document contents\"]').click()");
            }
            until(scenario, "!document.querySelector('textarea[aria-label=\"Document text\"]')"
                + ".readOnly", 20_000);
            byte[] leased = readProvider(target, TestDocumentsProvider.DOCUMENT_ID);
            assertFalse(Arrays.equals(original, leased));

            File hidden = new File(target.getFilesDir(), "work-journals-hidden-" +
                System.nanoTime());
            Files.move(journalDirectory.toPath(), hidden.toPath());
            Files.write(journalDirectory.toPath(), new byte[] { 1 });
            try {
                setDocumentText(scenario, "alpha\nfailed draft\n");
                until(scenario, "document.querySelector('[aria-label=\"Recovery journal state\"]')"
                    + ".textContent.includes('needs attention')", 10_000);
                assertFalse("Failed checkpoint was advertised as durable", journal.exists());
            } finally {
                Files.deleteIfExists(journalDirectory.toPath());
                Files.move(hidden.toPath(), journalDirectory.toPath(),
                    StandardCopyOption.ATOMIC_MOVE);
            }

            setDocumentText(scenario, "alpha\nAndroid local draft\n");
            until(scenario, "document.querySelector('[aria-label=\"Recovery journal state\"]')"
                + ".textContent.includes('Checkpoint ready')", 10_000);
            long deadline = SystemClock.uptimeMillis() + 10_000;
            while (!journal.isFile() && SystemClock.uptimeMillis() < deadline)
                SystemClock.sleep(50);
            assertTrue("Encrypted checkpoint missing", journal.isFile());
            String envelope = new String(Files.readAllBytes(journal.toPath()),
                StandardCharsets.UTF_8);
            assertFalse(envelope.contains("Android local draft"));
            assertFalse("Local checkpoint claimed target publication",
                envelope.contains("bootstrap"));
            assertArrayEquals("Checkpoint changed the selected document", leased,
                readProvider(target, TestDocumentsProvider.DOCUMENT_ID));
            String denied = eval(scenario, "(()=>{window.__lease='pending';"
                + "window.Capacitor.Plugins.Scpefe.enterEditMode().then(() => "
                + "window.__lease='unexpected').catch(e=>window.__lease=e.code);"
                + "return true})()");
            assertEquals("true", denied);
            until(scenario, "window.__lease!=='pending'", 10_000);
            assertEquals("\"LEASE_ACTIVE\"", eval(scenario, "window.__lease"));

            scenario.recreate();
            waitForChange(target, TestDocumentsProvider.DOCUMENT_ID, leased);
            waitForStableJournal(journal);
            until(scenario, "document.querySelector('[aria-label=\"Document state\"]')",
                15_000);
            openFixture(scenario, device);
            until(scenario, "[...document.querySelectorAll('button')]"
                + ".some(x=>x.textContent==='Restore unsaved work')", 15_000);
            eval(scenario, "[...document.querySelectorAll('button')]"
                + ".find(x=>x.textContent==='Restore unsaved work').click()");
            until(scenario, "document.querySelector('textarea[aria-label=\"Document text\"]')"
                + ".value==='alpha\\nAndroid local draft\\n'", 20_000);
            assertEquals("false", eval(scenario,
                "document.querySelector('textarea[aria-label=\"Document text\"]').readOnly"));

            byte[] restoredLease = readProvider(target, TestDocumentsProvider.DOCUMENT_ID);
            scenario.recreate();
            waitForChange(target, TestDocumentsProvider.DOCUMENT_ID, restoredLease);
            waitForStableJournal(journal);
            replaceProvider(target, TestDocumentsProvider.DOCUMENT_ID, original);
            openFixture(scenario, device);
            until(scenario, "document.body.textContent.includes('earlier authenticated head')",
                15_000);
            assertEquals("false", eval(scenario,
                "[...document.querySelectorAll('button')]"
                + ".some(x=>x.textContent==='Restore unsaved work')"));
        } finally {
            Files.deleteIfExists(journal.toPath());
            if (fixtureSelected)
                replaceProvider(target, TestDocumentsProvider.DOCUMENT_ID, original);
        }
    }

    @Test public void profileCreateOpenWindowsAndRejectStaleSlowUnlock() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            ensureProfile(scenario);

            menu(scenario, "File", "New");
            UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
            provider(device);
            click(device, Pattern.compile("(?i)save"));
            until(scenario, "document.querySelector('input[name=ownerPassword]')", 10_000);
            setInput(scenario, "ownerPassword", OWNER);
            setInput(scenario, "ownerPasswordConfirmation", OWNER);
            eval(scenario, "document.querySelector('input[name=understandsIrrecoverable]').click()");
            eval(scenario, "document.querySelector('input[name=ownerPassword]').form.requestSubmit()");
            until(scenario, "!document.querySelector('input[name=ownerPassword]')", 30_000);
            assertEquals("\"\"", eval(scenario,
                "document.querySelector('textarea[aria-label=\"Document text\"]').value"));

            menu(scenario, "File", "Close");
            until(scenario, "document.querySelector('textarea[aria-label=\"Document text\"]').disabled",
                10_000);
            menu(scenario, "File", "Open…");
            provider(device);
            click(device, Pattern.compile("created-.*\\.scpefe"));
            finishOpenPicker(scenario, device);
            setInput(scenario, "password", "wrong password");
            eval(scenario, "document.querySelector('input[name=password]').form.requestSubmit()");
            until(scenario, "document.querySelector('[role=alert]')", 15_000);
            setInput(scenario, "password", OWNER);
            eval(scenario, "document.querySelector('input[name=password]').form.requestSubmit()");
            until(scenario, "!document.querySelector('input[name=password]')", 15_000);
            until(scenario, "['Read-only','Edit mode'].includes(document.querySelector("
                + "'[aria-label=\"Document state\"]').textContent)", 15_000);

            menu(scenario, "File", "Close");
            menu(scenario, "File", "Open…");
            provider(device);
            click(device, Pattern.compile("test\\.scpefe"));
            finishOpenPicker(scenario, device);
            setInput(scenario, "password", WINDOWS);
            eval(scenario, "document.querySelector('input[name=password]').form.requestSubmit()");
            until(scenario, "document.querySelector('textarea[aria-label=\"Document text\"]')"
                + ".value==='alpha\\n'", 20_000);

            menu(scenario, "Security", "Lock");
            until(scenario, "document.querySelector('textarea[aria-label=\"Document text\"]').disabled",
                10_000);
            eval(scenario, "(()=>{window.__beats=0;window.__slow='pending';"
                + "const timer=setInterval(()=>window.__beats++,50);"
                + "window.Capacitor.Plugins.Scpefe.unlockDocument({password:'" + WINDOWS
                + "',debugDelayMs:1500}).then(()=>window.__slow='unexpected-success')"
                + ".catch(e=>window.__slow=e.code).finally(()=>clearInterval(timer));"
                + "setTimeout(()=>window.Capacitor.Plugins.Scpefe.closeDocument(),100);return true})()");
            until(scenario, "window.__slow!=='pending'", 10_000);
            assertEquals("\"STALE_OPERATION\"", eval(scenario, "window.__slow"));
            assertTrue("WebView timer stalled during slow unlock",
                Integer.parseInt(eval(scenario, "window.__beats")) >= 5);
        }
    }
}
