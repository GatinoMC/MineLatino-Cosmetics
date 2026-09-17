package com.minelatino.cosmetics.client;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.minelatino.cosmetics.core.MenuPolicy;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import net.minecraft.Util;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.ConfirmLinkScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.contents.TranslatableContents;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Shared UI, called by Fabric's mixin and Forge's native screen event. */
public final class PauseMenu {
    private static final Logger LOG = LoggerFactory.getLogger("MineLatino Cosmetics");
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private PauseMenu() {}

    /**
     * Sync the menu config from the backend before reading it locally.
     * This ensures the player always has the latest configuration.
     */
    private static void syncMenuConfig() {
        try {
            ApiClient api = CosmeticsClient.instance().api();
            ApiClient.PauseMenuConfigResponse response = api.pauseMenuConfig();
            if (response != null && response.config() != null) {
                java.nio.file.Path path = Minecraft.getInstance().gameDirectory.toPath()
                    .resolve("config/minelatino-cosmetics/menu.json");
                Files.createDirectories(path.getParent());
                Files.writeString(path, GSON.toJson(response.config()));
            }
        } catch (Exception e) {
            LOG.debug("Menu config sync failed, using local cache", e);
        }
    }

    public static void install(Screen screen, Consumer<AbstractWidget> add) {
        if (screen.children().isEmpty()) return;
        // Sync from backend before reading
        syncMenuConfig();
        Minecraft minecraft = Minecraft.getInstance();
        MenuConfig config = MenuConfig.read(minecraft.gameDirectory.toPath());
        // Personalization belongs to the local mod and stays available even if
        // the remotely configurable MineLatino links are temporarily disabled.
        for (var child : List.copyOf(screen.children())) {
            if (child instanceof Button old
                    && old.getMessage().getContents() instanceof TranslatableContents contents
                    && contents.getKey().equals("menu.playerReporting")) {
                int x = old.getX(), y = old.getY(), w = old.getWidth(), h = old.getHeight();
                old.setX(-0x4000);
                add.accept(Button.builder(Component.literal("Personalizar"), button ->
                        minecraft.setScreen(new HudEditorScreen(screen))).bounds(x, y, w, h).build());
            }
        }
        if (!config.enabled()) return;
        // Phase 1: rename labels and collect buttons that need URL overrides
        record PendingReplace(Button button, String key, int x, int y, int width, int height) {}
        List<PendingReplace> toReplace = new ArrayList<>();
        for (var child : screen.children()) {
            if (child instanceof Button button && button.getMessage().getContents() instanceof TranslatableContents contents) {
                String key = contents.getKey();
                if (key.equals("menu.playerReporting")) continue;
                String replacement = config.labels().get(key);
                if (replacement != null) button.setMessage(Component.literal(replacement));
                if (config.vanillaUrls().containsKey(key)) {
                    toReplace.add(new PendingReplace(button, key, button.getX(), button.getY(), button.getWidth(), button.getHeight()));
                }
            }
        }
        // Hide every overridden vanilla button before measuring free space. This
        // keeps the pending Discord/Tienda pair from blocking one another while
        // still treating buttons injected by Mod Menu/Forge as occupied.
        for (var pending : toReplace) pending.button().setX(-0x4000);
        // Phase 2: add URL replacements at their original position when free,
        // or at the first unobstructed row when another mod already owns it.
        for (var pending : toReplace) {
            String url = config.vanillaUrls().get(pending.key());
            if (url == null) continue;
            var uri = MenuPolicy.website(url);
            int x = pending.x(), w = pending.width(), h = pending.height();
            int y = findFreeY(screen, x, pending.y(), w, h);
            Component label = pending.button().getMessage();
            add.accept(Button.builder(label, btn -> {
                minecraft.setScreen(new ConfirmLinkScreen(confirmed -> {
                    if (confirmed) Util.getPlatform().openUri(uri);
                    minecraft.setScreen(screen);
                }, uri.toString(), true));
            }).bounds(x, y, w, h).build());
        }
        int index = 0;
        int count = config.buttons().size();
        int buttonWidth = count == 0 ? 150 : Math.min(150, (screen.width - 12 - (count - 1) * 4) / count);
        int startX = (screen.width - count * buttonWidth - Math.max(0, count - 1) * 4) / 2;
        for (MenuConfig.Entry entry : config.buttons()) {
            add.accept(Button.builder(Component.literal(entry.label()), button -> {
                if (entry.action() == MenuPolicy.Action.WARDROBE) {
                    minecraft.setScreen(new WardrobeScreen(screen));
                } else {
                    var uri = MenuPolicy.website(entry.url());
                    minecraft.setScreen(new ConfirmLinkScreen(confirmed -> {
                        if (confirmed) Util.getPlatform().openUri(uri);
                        minecraft.setScreen(screen);
                    }, uri.toString(), true));
                }
            }).bounds(startX + index++ * (buttonWidth + 4), 6, buttonWidth, 20).build());
        }
    }

    private static int findFreeY(Screen screen, int x, int preferredY, int width, int height) {
        if (!isOccupied(screen, x, preferredY, width, height)) return preferredY;
        int maxY = Math.max(30, screen.height - height - 4);
        for (int y = 30; y <= maxY; y += height + 4) {
            if (!isOccupied(screen, x, y, width, height)) return y;
        }
        return preferredY;
    }

    private static boolean isOccupied(Screen screen, int x, int y, int width, int height) {
        for (var child : screen.children()) {
            if (!(child instanceof AbstractWidget widget) || !widget.visible || widget.getX() < -1000) continue;
            if (x < widget.getX() + widget.getWidth() + 2
                    && x + width + 2 > widget.getX()
                    && y < widget.getY() + widget.getHeight() + 2
                    && y + height + 2 > widget.getY()) return true;
        }
        return false;
    }
}
