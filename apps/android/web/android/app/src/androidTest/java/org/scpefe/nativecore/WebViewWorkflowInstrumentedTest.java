package org.scpefe.nativecore;

import static org.junit.Assert.*;

import android.os.SystemClock;
import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.Until;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.scpefe.nativecore.smoke.MainActivity;

/** Drives the real Capacitor WebView and Android picker against a local provider. */
@RunWith(AndroidJUnit4.class)
public final class WebViewWorkflowInstrumentedTest {
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
        fail("WebView condition did not become true: " + condition);
    }

    private static void menu(ActivityScenario<MainActivity> scenario, String menu,
            String action) throws Exception {
        eval(scenario, "document.querySelector('[aria-label=\"" + menu
            + "\"][aria-haspopup=\"menu\"]').click()");
        until(scenario, "[...document.querySelectorAll('[role=menu] button')]"
            + ".some(x=>x.querySelector('span')?.textContent.trim()==='" + action + "')", 5_000);
        eval(scenario, "[...document.querySelectorAll('[role=menu] button')]"
            + ".find(x=>x.querySelector('span')?.textContent.trim()==='" + action
            + "').click()");
    }

    private static void click(UiDevice device, Pattern label) {
        UiObject2 item = device.wait(Until.findObject(By.text(label)), 10_000);
        assertNotNull("Picker item missing: " + label, item);
        item.click();
    }

    private static void provider(UiDevice device) {
        UiObject2 root = device.wait(Until.findObject(By.text("SCPEFE test provider")), 2_000);
        if (root == null) {
            UiObject2 roots = device.wait(Until.findObject(By.descContains("Show roots")), 5_000);
            if (roots != null) roots.click();
            root = device.wait(Until.findObject(By.text("SCPEFE test provider")), 10_000);
        }
        assertNotNull("Test provider not visible in system picker", root);
        root.click();
    }

    private static void setInput(ActivityScenario<MainActivity> scenario, String name,
            String value) throws Exception {
        eval(scenario, "(()=>{const e=document.querySelector('input[name=\"" + name
            + "\"]');if(!e)return false;Object.getOwnPropertyDescriptor("
            + "HTMLInputElement.prototype,'value').set.call(e,'" + value + "');"
            + "e.dispatchEvent(new Event('input',{bubbles:true}));return true})()");
    }

    @Test public void profileCreateOpenWindowsAndRejectStaleSlowUnlock() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            until(scenario, "document.querySelector('input[name=name]')", 15_000);
            setInput(scenario, "name", "Ada");
            setInput(scenario, "email", "ada@example.org");
            setInput(scenario, "deviceName", "Android emulator");
            eval(scenario, "document.querySelector('input[name=name]').form.requestSubmit()");
            until(scenario, "!document.querySelector('input[name=name]')", 10_000);

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
            click(device, Pattern.compile("(?i)open"));
            until(scenario, "document.querySelector('input[name=password]')", 10_000);
            setInput(scenario, "password", "wrong password");
            eval(scenario, "document.querySelector('input[name=password]').form.requestSubmit()");
            until(scenario, "document.querySelector('[role=alert]')", 15_000);
            setInput(scenario, "password", OWNER);
            eval(scenario, "document.querySelector('input[name=password]').form.requestSubmit()");
            until(scenario, "!document.querySelector('input[name=password]')", 15_000);

            menu(scenario, "File", "Close");
            menu(scenario, "File", "Open…");
            provider(device);
            click(device, Pattern.compile("test\\.scpefe"));
            click(device, Pattern.compile("(?i)open"));
            until(scenario, "document.querySelector('input[name=password]')", 10_000);
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
