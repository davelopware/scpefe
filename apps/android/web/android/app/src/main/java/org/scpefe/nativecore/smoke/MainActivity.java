package org.scpefe.nativecore.smoke;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;
import org.scpefe.nativecore.ScpefePlugin;

/** Hosts the local SCPEFE bundle and its single narrow native bridge. */
public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle state) {
        registerPlugin(ScpefePlugin.class);
        super.onCreate(state);
    }
}
