package com.minelatino.cosmetics.client;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;

/**
 * HTTP client for the MineLatino Cosmetics backend.
 * Uses only java.net.http (no external dependencies). All responses are parsed
 * through Gson into simple DTOs, then converted to domain types.
 */
public final class ApiClient implements WardrobeController.Gateway {
    private static final Gson GSON = new Gson();
    private static final Duration TIMEOUT = Duration.ofSeconds(8);

    private final String baseUrl;
    private final HttpClient http;
    private final boolean accountMode;
    private static final int MAX_JSON_RESPONSE = 1024 * 1024;
    private record TextResponse(int statusCode, String body) {}

    public ApiClient(String baseUrl) {
        this(baseUrl, false);
    }

    public ApiClient(String baseUrl, boolean accountMode) {
        this.baseUrl = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
        this.accountMode = accountMode;
        this.http = HttpClient.newBuilder().connectTimeout(TIMEOUT).build();
    }

    /** Returns the base URL this client connects to. */
    public String getBaseUrl() {
        return baseUrl;
    }

    // ── Auth ──────────────────────────────────────────────────────────

    public record ChallengeResponse(String challengeId, String serverId, long expiresAt) {}

    public ChallengeResponse challenge(String username) throws Exception {
        JsonObject body = new JsonObject();
        body.addProperty("username", username);
        TextResponse response = post("/v1/auth/challenge", body.toString(), null);
        if (response.statusCode() != 201) throw new ApiException(response.statusCode(), "challenge");
        JsonObject json = GSON.fromJson(response.body(), JsonObject.class);
        return new ChallengeResponse(
            json.get("challengeId").getAsString(),
            json.get("serverId").getAsString(),
            json.get("expiresAt").getAsLong()
        );
    }

    public record VerifyResponse(String token, long expiresAt, String uuid, String name) {}

    public VerifyResponse verify(String challengeId) throws Exception {
        JsonObject body = new JsonObject();
        body.addProperty("challengeId", challengeId);
        TextResponse response = post("/v1/auth/verify", body.toString(), null);
        if (response.statusCode() != 200) throw new ApiException(response.statusCode(), "verify");
        JsonObject json = GSON.fromJson(response.body(), JsonObject.class);
        return new VerifyResponse(
            json.get("token").getAsString(),
            json.get("expiresAt").getAsLong(),
            json.get("uuid").getAsString(),
            json.get("name").getAsString()
        );
    }

    public void logout(String token) throws Exception {
        TextResponse response = post(accountMode ? "/v1/account/logout" : "/v1/auth/logout", "{}", token);
        if (response.statusCode() != 200) throw new ApiException(response.statusCode(), "logout");
    }

    public record AccountInfo(String accountId, String nick, String status) {}
    private record AccountResponse(AccountInfo account) {}

    public AccountInfo accountSession(String token, String uuid, String name) throws Exception {
        JsonObject body = new JsonObject(); body.addProperty("uuid", uuid); body.addProperty("name", name);
        TextResponse presence = post("/v1/account/presence", body.toString(), token);
        if (presence.statusCode() != 200) throw responseError(presence, "account-presence");
        TextResponse response = get("/v1/account/session", token);
        if (response.statusCode() != 200) throw responseError(response, "account-session");
        AccountResponse parsed = GSON.fromJson(response.body(), AccountResponse.class);
        if (parsed == null || parsed.account() == null) throw new ApiException(502, "invalid-account-session");
        return parsed.account();
    }

    // ── Wardrobe ──────────────────────────────────────────────────────

    public record WardrobeResponse(String uuid, List<CosmeticItem> owned, List<EquippedEntry> equipped) {}
    public record CosmeticItem(String id, String name, String slot, String status, long revision) {}
    public record EquippedEntry(String slot, String cosmeticId) {}

    public WardrobeResponse wardrobe(String token) throws Exception {
        TextResponse response = get(accountMode ? "/v1/account/wardrobe" : "/v1/cosmetics/me/wardrobe", token);
        if (response.statusCode() != 200) throw responseError(response, "wardrobe");
        return GSON.fromJson(response.body(), WardrobeResponse.class);
    }

    public record EquipResponse(List<EquippedEntry> equipped) {}

    public EquipResponse equip(String token, String slot, String cosmeticId) throws Exception {
        JsonObject body = new JsonObject();
        body.addProperty("slot", slot);
        if (cosmeticId != null) body.addProperty("cosmeticId", cosmeticId);
        else body.add("cosmeticId", com.google.gson.JsonNull.INSTANCE);
        TextResponse response = put(accountMode ? "/v1/account/equipment" : "/v1/cosmetics/me/equipment", body.toString(), token);
        if (response.statusCode() != 200) throw responseError(response, "equip");
        return GSON.fromJson(response.body(), EquipResponse.class);
    }

    // ── Appearance (batch) ────────────────────────────────────────────

    public record AppearanceEntry(String slot, String cosmeticId) {}
    public record PlayerAppearance(String uuid, String name, List<AppearanceEntry> equipped) {}
    public record AppearanceResponse(List<PlayerAppearance> players) {}

    public AppearanceResponse appearance(List<String> uuids) throws Exception {
        return appearance(uuids, List.of());
    }

    public AppearanceResponse appearance(List<String> uuids, List<String> names) throws Exception {
        String joined = String.join(",", uuids);
        String joinedNames = String.join(",", names);
        TextResponse response = get("/v1/cosmetics/appearance?uuids=" + joined + "&names=" + joinedNames, null);
        if (response.statusCode() != 200) throw new ApiException(response.statusCode(), "appearance");
        AppearanceResponse parsed = GSON.fromJson(response.body(), AppearanceResponse.class);
        if (parsed == null || parsed.players() == null || parsed.players().size() > 100) {
            throw new ApiException(502, "invalid-appearance");
        }
        return parsed;
    }

    public record ActiveAfkPlayers(List<String> uuids) {}

    public ActiveAfkPlayers activeAfkPlayers() throws Exception {
        TextResponse response = get("/v1/afk/active-players", null);
        if (response.statusCode() != 200) throw responseError(response, "afk-indicator");
        ActiveAfkPlayers parsed = GSON.fromJson(response.body(), ActiveAfkPlayers.class);
        if (parsed == null || parsed.uuids() == null || parsed.uuids().size() > 1000)
            throw new ApiException(502, "invalid-afk-indicator");
        return parsed;
    }

    // ── Health ────────────────────────────────────────────────────────

    public record HealthResponse(boolean ok, boolean premiumEnabled, boolean offlineAuthEnabled, String stage) {}

    public HealthResponse health() throws Exception {
        TextResponse response = get("/health", null);
        if (response.statusCode() != 200) throw new ApiException(response.statusCode(), "health");
        return GSON.fromJson(response.body(), HealthResponse.class);
    }

    // ── Pause Menu Config ─────────────────────────────────────────────

    public record PauseMenuConfigResponse(int revision, MenuConfig config) {}

    public PauseMenuConfigResponse pauseMenuConfig() throws Exception {
        TextResponse response = get("/v1/client-config/pause-menu", null);
        if (response.statusCode() != 200) throw new ApiException(response.statusCode(), "pause-menu");
        return GSON.fromJson(response.body(), PauseMenuConfigResponse.class);
    }

    // ── Cosmetic Transforms ────────────────────────────────────────────

    public record TransformData(float[] translation, float[] rotation, float[] scale) {}
    public record CosmeticTransformsResponse(Map<String, Map<String, TransformData>> transforms) {}

    public CosmeticTransformsResponse cosmeticTransforms() throws Exception {
        TextResponse response = get("/v1/client-config/cosmetic-transforms", null);
        if (response.statusCode() != 200) throw new ApiException(response.statusCode(), "cosmetic-transforms");
        CosmeticTransformsResponse parsed = GSON.fromJson(response.body(), CosmeticTransformsResponse.class);
        if (parsed == null || parsed.transforms() == null) return new CosmeticTransformsResponse(Map.of());
        for (var cosmetic : parsed.transforms().entrySet()) {
            if (cosmetic.getKey() == null || cosmetic.getValue() == null) throw new ApiException(502, "invalid-cosmetic-transforms");
            for (var slot : cosmetic.getValue().entrySet()) validateTransform(slot.getValue());
        }
        return parsed;
    }

    private static void validateTransform(TransformData transform) throws ApiException {
        if (transform == null || !validVector(transform.translation(), 1024, false)
                || !validVector(transform.rotation(), 36_000, false)
                || !validVector(transform.scale(), 100, true)) {
            throw new ApiException(502, "invalid-cosmetic-transform");
        }
    }

    private static boolean validVector(float[] values, float limit, boolean positive) {
        if (values == null || values.length != 3) return false;
        for (float value : values) {
            if (!Float.isFinite(value) || Math.abs(value) > limit || (positive && value <= 0)) return false;
        }
        return true;
    }

    // ── HTTP primitives ───────────────────────────────────────────────

    private TextResponse get(String path, String token) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder()
            .uri(URI.create(baseUrl + path))
            .timeout(TIMEOUT)
            .GET();
        if (token != null) builder.header("Authorization", "Bearer " + token);
        return send(builder);
    }

    private TextResponse post(String path, String jsonBody, String token) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder()
            .uri(URI.create(baseUrl + path))
            .timeout(TIMEOUT)
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(jsonBody));
        if (token != null) builder.header("Authorization", "Bearer " + token);
        return send(builder);
    }

    private TextResponse put(String path, String jsonBody, String token) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder()
            .uri(URI.create(baseUrl + path))
            .timeout(TIMEOUT)
            .header("Content-Type", "application/json")
            .PUT(HttpRequest.BodyPublishers.ofString(jsonBody));
        if (token != null) builder.header("Authorization", "Bearer " + token);
        return send(builder);
    }

    private TextResponse send(HttpRequest.Builder builder) throws Exception {
        HttpRequest request=builder.build();
        String route=request.method()+" "+request.uri().getPath();
        long start=System.nanoTime();
        try {
            HttpResponse<InputStream> raw=http.send(request, HttpResponse.BodyHandlers.ofInputStream());
            byte[] bytes;
            try (InputStream input = raw.body()) { bytes = input.readNBytes(MAX_JSON_RESPONSE + 1); }
            if (bytes.length > MAX_JSON_RESPONSE) throw new ApiException(502, "response-too-large");
            var response=new TextResponse(raw.statusCode(), new String(bytes, StandardCharsets.UTF_8));
            CosmeticsDiagnostics.event("HTTP",route+" status="+response.statusCode()+" ms="+(System.nanoTime()-start)/1_000_000);
            return response;
        } catch(Exception e) {
            CosmeticsDiagnostics.event("HTTP_FAILED",route+" "+CosmeticsDiagnostics.failure(e));
            throw e;
        }
    }

    public static final class ApiException extends Exception {
        public final int status;
        public ApiException(int status, String context) {
            super("API " + context + " failed: " + status);
            this.status = status;
        }
    }

    private static ApiException responseError(TextResponse response, String context) {
        try {
            String message = GSON.fromJson(response.body(), JsonObject.class).get("error").getAsString();
            return new ApiException(response.statusCode(), message.length() <= 180 ? message : context);
        } catch (RuntimeException ignored) {
            return new ApiException(response.statusCode(), context);
        }
    }
}
