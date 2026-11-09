package org.scpefe.nativecore;

import android.content.Context;
import android.util.Base64;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Authenticates client-local last-seen heads without using provider metadata. */
public final class AndroidHeadWitnesses {
    /** The frontend must request an explicit decision for non-descendant heads. */
    public enum Comparison { FIRST, UNCHANGED, DESCENDANT, ROLLBACK, DIVERGENCE,
        REPLACEMENT, UNREADABLE }

    private final PrivateStateFiles files;

    /** Uses app-private storage excluded by the application backup policy. */
    public AndroidHeadWitnesses(Context context) {
        files = new PrivateStateFiles(context, "client-state");
    }

    AndroidHeadWitnesses(PrivateStateFiles files) { this.files = files; }

    /** Returns the prior authenticated witness for a stable opaque target. */
    public JSONObject read(String target) throws IOException {
        return entries().optJSONObject(targetHash(target));
    }

    /** Compares an authenticated observation and records only safe progress. */
    public Comparison observe(String target, JSONObject observation) throws IOException {
        validateWitness(observation);
        JSONObject all = entries();
        String key = targetHash(target);
        JSONObject prior = all.optJSONObject(key);
        Comparison comparison = compare(prior, observation);
        if (comparison == Comparison.FIRST || comparison == Comparison.UNCHANGED
                || comparison == Comparison.DESCENDANT) {
            try {
                JSONObject retained = new JSONObject(observation.toString());
                retained.put("graph", mergedGraph(prior == null ? null
                    : prior.optJSONArray("graph"), observation.optJSONArray("graph")));
                all.put(key, retained);
            }
            catch (JSONException error) { throw new IOException("invalid head witness", error); }
            save(all);
        }
        return comparison;
    }

    /** Replaces a witness only after an explicit frontend decision. */
    public void accept(String target, JSONObject observation) throws IOException {
        validateWitness(observation);
        JSONObject all = entries();
        try { all.put(targetHash(target), observation); }
        catch (JSONException error) { throw new IOException("invalid head witness", error); }
        save(all);
    }

    /** Converts unreadable state into structured attention without deleting it. */
    public Comparison inspect(String target, JSONObject observation) {
        try { return compare(read(target), observation); }
        catch (IOException error) { return Comparison.UNREADABLE; }
    }

    private static Comparison compare(JSONObject prior, JSONObject current) throws IOException {
        validateWitness(current);
        if (prior == null) return Comparison.FIRST;
        validateWitness(prior);
        String previousId = prior.optString("documentId");
        String currentId = current.optString("documentId");
        if (!previousId.equals(currentId)) return Comparison.REPLACEMENT;
        String previousHead = prior.optString("headRevision");
        String currentHead = current.optString("headRevision");
        if (previousHead.equals(currentHead)) return Comparison.UNCHANGED;
        JSONArray graph = mergedGraph(prior.optJSONArray("graph"),
            current.optJSONArray("graph"));
        if (reaches(graph, currentHead, previousHead)) {
            return Comparison.DESCENDANT;
        }
        if (reaches(graph, previousHead, currentHead)) {
            return Comparison.ROLLBACK;
        }
        return Comparison.DIVERGENCE;
    }

    private static JSONArray mergedGraph(JSONArray previous, JSONArray observed)
            throws IOException {
        Map<String, Set<String>> nodes = new LinkedHashMap<>();
        for (JSONArray source : new JSONArray[] { previous, observed }) {
            if (source == null) continue;
            for (int index = 0; index < source.length(); index++) {
                JSONObject node = source.optJSONObject(index);
                String id = node.optString("revisionId");
                Set<String> parents = nodes.computeIfAbsent(id, ignored -> new LinkedHashSet<>());
                JSONArray listed = node.optJSONArray("parentRevisionIds");
                for (int parent = 0; parent < listed.length(); parent++) {
                    parents.add(listed.optString(parent));
                }
                if (parents.size() > 8 || nodes.size() > 1025) {
                    throw new IOException("head witness graph exceeds its limit");
                }
            }
        }
        JSONArray merged = new JSONArray();
        try {
            for (Map.Entry<String, Set<String>> node : nodes.entrySet()) {
                JSONArray parents = new JSONArray();
                for (String parent : node.getValue()) parents.put(parent);
                merged.put(new JSONObject().put("revisionId", node.getKey())
                    .put("parentRevisionIds", parents));
            }
        } catch (JSONException error) { throw new IOException("invalid head graph", error); }
        return merged;
    }

    private static boolean reaches(JSONArray graph, String from, String sought) {
        Set<String> visited = new HashSet<>();
        Set<String> frontier = new HashSet<>();
        frontier.add(from);
        while (!frontier.isEmpty()) {
            String head = frontier.iterator().next();
            frontier.remove(head);
            if (head.equals(sought)) return true;
            if (!visited.add(head)) continue;
            for (int index = 0; index < graph.length(); index++) {
                JSONObject node = graph.optJSONObject(index);
                if (node != null && head.equals(node.optString("revisionId"))) {
                    JSONArray parents = node.optJSONArray("parentRevisionIds");
                    if (parents != null) for (int parent = 0; parent < parents.length(); parent++) {
                        frontier.add(parents.optString(parent));
                    }
                }
            }
        }
        return false;
    }

    private static void validateWitness(JSONObject value) throws IOException {
        if (value == null || !value.optString("documentId").matches("[0-9a-f]{32}")
                || !value.optString("headRevision").matches("[0-9a-f]{64}")) {
            throw new IOException("invalid head witness");
        }
        JSONArray graph = value.optJSONArray("graph");
        if (graph == null || graph.length() > 1025) throw new IOException("invalid head witness");
        Set<String> ids = new HashSet<>();
        for (int index = 0; index < graph.length(); index++) {
            JSONObject node = graph.optJSONObject(index);
            if (node == null || !node.optString("revisionId").matches("[0-9a-f]{64}")
                    || !ids.add(node.optString("revisionId"))) {
                throw new IOException("invalid head witness");
            }
            JSONArray parents = node.optJSONArray("parentRevisionIds");
            if (parents == null || parents.length() > 8) throw new IOException("invalid head witness");
            for (int parent = 0; parent < parents.length(); parent++) {
                if (!parents.optString(parent).matches("[0-9a-f]{64}")) {
                    throw new IOException("invalid head witness");
                }
            }
        }
        if (!ids.contains(value.optString("headRevision"))) {
            throw new IOException("invalid head witness");
        }
    }

    private JSONObject entries() throws IOException {
        byte[] raw = files.read("head-witnesses.json");
        if (raw == null) return new JSONObject();
        try {
            JSONObject envelope = new JSONObject(new String(raw, StandardCharsets.UTF_8));
            if (envelope.getInt("version") != 1) throw new JSONException("version");
            byte[] payload = Base64.decode(envelope.getString("payload"), Base64.NO_WRAP);
            byte[] supplied = Base64.decode(envelope.getString("mac"), Base64.NO_WRAP);
            if (!MessageDigest.isEqual(supplied, hmac(key(false), payload))) {
                throw new IOException("head witness integrity check failed");
            }
            JSONObject result = new JSONObject(new String(payload, StandardCharsets.UTF_8));
            java.util.Iterator<String> keys = result.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                if (!key.matches("[0-9a-f]{64}")) throw new JSONException("target");
                validateWitness(result.getJSONObject(key));
            }
            return result;
        } catch (JSONException | IllegalArgumentException error) {
            throw new IOException("head witness is unreadable", error);
        }
    }

    private void save(JSONObject entries) throws IOException {
        byte[] payload = entries.toString().getBytes(StandardCharsets.UTF_8);
        try {
            JSONObject envelope = new JSONObject().put("version", 1)
                .put("payload", Base64.encodeToString(payload, Base64.NO_WRAP))
                .put("mac", Base64.encodeToString(hmac(key(true), payload), Base64.NO_WRAP));
            files.write("head-witnesses.json",
                (envelope.toString() + "\n").getBytes(StandardCharsets.UTF_8));
        } catch (JSONException error) { throw new IOException("head witness save failed", error); }
    }

    private byte[] key(boolean create) throws IOException {
        byte[] key = files.read("head-witness.key");
        if (key != null) {
            if (key.length != 32) throw new IOException("head witness key is unreadable");
            return key;
        }
        if (!create) throw new IOException("head witness key is missing");
        key = new byte[32];
        new SecureRandom().nextBytes(key);
        files.write("head-witness.key", key);
        return key;
    }

    private static byte[] hmac(byte[] key, byte[] payload) throws IOException {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            return mac.doFinal(payload);
        } catch (GeneralSecurityException error) { throw new IOException("head witness MAC failed", error); }
    }

    private static String targetHash(String target) {
        if (target == null || target.isEmpty()) throw new IllegalArgumentException("target");
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256")
                .digest(target.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (byte value : hash) hex.append(String.format("%02x", value & 0xff));
            return hex.toString();
        } catch (GeneralSecurityException error) { throw new AssertionError(error); }
    }
}
