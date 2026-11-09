package org.scpefe.nativecore;

import android.content.Context;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.json.JSONException;
import org.json.JSONObject;

/** Persists the shared frontend profile and client-settings JSON shapes. */
public final class AndroidProfileSettings {
    private final PrivateStateFiles files;

    /** Uses app-private storage excluded by the application backup policy. */
    public AndroidProfileSettings(Context context) {
        files = new PrivateStateFiles(context, "client-state");
    }

    AndroidProfileSettings(PrivateStateFiles files) { this.files = files; }

    /** Loads a validated profile, or null before first client setup. */
    public JSONObject loadProfile() throws IOException {
        byte[] bytes = files.read("profile.json");
        return bytes == null ? null : validateProfile(parse(bytes));
    }

    /** Saves only the three profile fields accepted by the shared contract. */
    public JSONObject saveProfile(JSONObject value) throws IOException {
        JSONObject profile = validateProfile(value);
        files.write("profile.json", utf8(profile));
        return profile;
    }

    /** Loads validated regular-save preferences with shared defaults. */
    public JSONObject loadSettings() throws IOException {
        byte[] bytes = files.read("settings.json");
        return validateSettings(bytes == null ? new JSONObject() : parse(bytes));
    }

    /** Saves only regular-save preferences accepted by the shared contract. */
    public JSONObject saveSettings(JSONObject value) throws IOException {
        JSONObject settings = validateSettings(value);
        files.write("settings.json", utf8(settings));
        return settings;
    }

    private static JSONObject validateProfile(JSONObject value) throws IOException {
        if (value == null) throw new IOException("invalid client profile");
        String name = requiredText(value.opt("name"));
        String email = requiredText(value.opt("email"));
        String device = requiredText(value.opt("deviceName"));
        if (name == null || email == null || device == null
                || !email.matches("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$")) {
            throw new IOException("invalid client profile");
        }
        try {
            return new JSONObject().put("name", name).put("email", email)
                .put("deviceName", device);
        } catch (JSONException error) { throw new IOException("invalid client profile", error); }
    }

    private static String requiredText(Object value) {
        if (!(value instanceof String)) return null;
        String text = ((String)value).trim();
        if (text.isEmpty() || text.getBytes(StandardCharsets.UTF_8).length > 512) return null;
        for (int index = 0; index < text.length(); index++) {
            char c = text.charAt(index);
            if (Character.isHighSurrogate(c)) {
                if (++index >= text.length() || !Character.isLowSurrogate(text.charAt(index))) {
                    return null;
                }
            } else if (Character.isLowSurrogate(c)) return null;
        }
        return text;
    }

    private static JSONObject validateSettings(JSONObject value) throws IOException {
        if (value == null) throw new IOException("invalid client settings");
        Object enabled = value.has("regularSaveEnabled")
            ? value.opt("regularSaveEnabled") : Boolean.FALSE;
        Object interval = value.has("regularSaveIntervalMs")
            ? value.opt("regularSaveIntervalMs") : Long.valueOf(120000);
        if (!(enabled instanceof Boolean) || !(interval instanceof Number)
                || ((Number)interval).doubleValue() != ((Number)interval).longValue()
                || ((Number)interval).longValue() < 10000
                || ((Number)interval).longValue() > 86400000) {
            throw new IOException("invalid client settings");
        }
        try {
            return new JSONObject().put("regularSaveEnabled", enabled)
                .put("regularSaveIntervalMs", ((Number)interval).longValue());
        } catch (JSONException error) { throw new IOException("invalid client settings", error); }
    }

    private static JSONObject parse(byte[] bytes) throws IOException {
        try { return new JSONObject(new String(bytes, StandardCharsets.UTF_8)); }
        catch (JSONException error) { throw new IOException("private state record is unreadable", error); }
    }

    private static byte[] utf8(JSONObject value) {
        return (value.toString() + "\n").getBytes(StandardCharsets.UTF_8);
    }
}
