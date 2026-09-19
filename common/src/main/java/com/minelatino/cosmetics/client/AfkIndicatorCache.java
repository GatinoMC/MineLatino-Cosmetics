package com.minelatino.cosmetics.client;

import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

/** Short-lived, server-reported AFK Farm badges. Never trusts local client state. */
public final class AfkIndicatorCache {
    private static final long POLL_MS = 10_000;
    private static final long FRESH_MS = 20_000;
    private final ApiClient api;
    private volatile Set<UUID> active = Set.of();
    private volatile long updatedAt;
    private volatile long generation;
    private long lastPoll;
    private volatile boolean polling;

    public AfkIndicatorCache(ApiClient api) { this.api = api; }

    public static boolean allowedServer(String address) {
        if (address == null) return false;
        String normalized = address.trim().toLowerCase(Locale.ROOT);
        return normalized.equals("play.minelatino.com")
                || normalized.matches("play\\.minelatino\\.com:[0-9]{1,5}");
    }

    public void tick(boolean inWorld) {
        if (!inWorld) {
            generation++;
            active = Set.of();
            updatedAt = 0;
            return;
        }
        long now = System.currentTimeMillis();
        if (polling || now - lastPoll < POLL_MS) return;
        polling = true;
        lastPoll = now;
        long requestGeneration = generation;
        CompletableFuture.supplyAsync(() -> {
            try {
                Set<UUID> uuids = new HashSet<>();
                for (String value : api.activeAfkPlayers().uuids()) {
                    if (value == null || !value.matches("[a-fA-F0-9]{32}")) continue;
                    uuids.add(UUID.fromString(value.replaceFirst(
                        "^(.{8})(.{4})(.{4})(.{4})(.{12})$", "$1-$2-$3-$4-$5")));
                }
                return Set.copyOf(uuids);
            } catch (Exception ignored) {
                return null;
            }
        }).whenComplete((result, error) -> {
            if (error == null && result != null && generation == requestGeneration) {
                active = result;
                updatedAt = System.currentTimeMillis();
            }
            polling = false;
        });
    }

    public boolean active(UUID uuid) {
        return uuid != null && System.currentTimeMillis() - updatedAt <= FRESH_MS && active.contains(uuid);
    }
}
