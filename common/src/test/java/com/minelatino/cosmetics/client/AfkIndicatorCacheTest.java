package com.minelatino.cosmetics.client;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AfkIndicatorCacheTest {
    @Test void badgesOnlyPollOnTheFarmServer() {
        assertTrue(AfkIndicatorCache.allowedServer("play.minelatino.com"));
        assertTrue(AfkIndicatorCache.allowedServer("PLAY.MINELATINO.COM:25565"));
        assertFalse(AfkIndicatorCache.allowedServer(null));
        assertFalse(AfkIndicatorCache.allowedServer("evilplay.minelatino.com"));
        assertFalse(AfkIndicatorCache.allowedServer("play.minelatino.com.evil.test"));
        assertFalse(AfkIndicatorCache.allowedServer("other.example.com"));
    }
}
