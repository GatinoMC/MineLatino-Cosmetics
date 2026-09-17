package com.minelatino.cosmetics.client;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.minelatino.cosmetics.core.MenuPolicy;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import net.minecraft.util.Util;
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
                add.accept(new PauseMenuIconButton(x, y, w, h, "Personalizar",
                        PauseMenuIconButton.Icon.GEAR,
                        () -> minecraft.gui.setScreen(new HudEditorScreen(screen))));
            }
        }
        if (!config.enabled()) return;
        // Phase 1: rename labels and collect buttons that need URL overrides
        record PendingReplace(Button button, String key) {}
        List<PendingReplace> toReplace = new ArrayList<>();
        for (var child : screen.children()) {
            if (child instanceof Button button && button.getMessage().getContents() instanceof TranslatableContents contents) {
                String key = contents.getKey();
                if (key.equals("menu.playerReporting")) continue;
                String replacement = config.labels().get(key);
                if (replacement != null) button.setMessage(Component.literal(replacement));
                if (config.vanillaUrls().containsKey(key)) toReplace.add(new PendingReplace(button, key));
            }
        }
        // Phase 2: for buttons with URL overrides, move vanilla button off-screen and add a replacement
        for (var pending : toReplace) {
            Button old = pending.button();
            String url = config.vanillaUrls().get(pending.key());
            if (url == null) continue;
            var uri = MenuPolicy.website(url);
            int x = old.getX(), y = old.getY(), w = old.getWidth(), h = old.getHeight();
            Component label = old.getMessage();
            old.setX(-0x4000);  // move vanilla button off-screen so it can't be clicked
            Runnable action = () -> {
                minecraft.gui.setScreen(new ConfirmLinkScreen(confirmed -> {
                    if (confirmed) Util.getPlatform().openUri(uri);
                    minecraft.gui.setScreen(screen);
                }, uri.toString(), true));
            };
            PauseMenuIconButton.Icon icon = compactIcon(label.getString(), url);
            if (icon != null) {
                add.accept(new PauseMenuIconButton(x, y, w, h, label.getString(), icon, action));
            } else {
                add.accept(Button.builder(label, button -> action.run()).bounds(x, y, w, h).build());
            }
        }
        int index = 0;
        int count = config.buttons().size();
        int buttonWidth = count == 0 ? 150 : Math.min(150, (screen.width - 12 - (count - 1) * 4) / count);
        int startX = (screen.width - count * buttonWidth - Math.max(0, count - 1) * 4) / 2;
        for (MenuConfig.Entry entry : config.buttons()) {
            Runnable action = () -> {
                if (entry.action() == MenuPolicy.Action.WARDROBE) {
                    minecraft.gui.setScreen(new WardrobeScreen(screen));
                } else {
                    var uri = MenuPolicy.website(entry.url());
                    minecraft.gui.setScreen(new ConfirmLinkScreen(confirmed -> {
                        if (confirmed) Util.getPlatform().openUri(uri);
                        minecraft.gui.setScreen(screen);
                    }, uri.toString(), true));
                }
            };
            int x = startX + index++ * (buttonWidth + 4);
            PauseMenuIconButton.Icon icon = compactIcon(entry);
            if (icon != null) {
                add.accept(new PauseMenuIconButton(x, 6, buttonWidth, 20, entry.label(), icon, action));
            } else {
                add.accept(Button.builder(Component.literal(entry.label()), button -> action.run())
                        .bounds(x, 6, buttonWidth, 20).build());
            }
        }
    }

    private static PauseMenuIconButton.Icon compactIcon(MenuConfig.Entry entry) {
        return compactIcon(entry.label(), entry.url());
    }

    private static PauseMenuIconButton.Icon compactIcon(String rawLabel, String rawUrl) {
        String label = rawLabel.toLowerCase(java.util.Locale.ROOT);
        String url = rawUrl == null ? "" : rawUrl.toLowerCase(java.util.Locale.ROOT);
        if (label.contains("tienda") || label.contains("shop") || label.contains("store")) {
            return PauseMenuIconButton.Icon.CART;
        }
        if (label.contains("discord") || url.contains("discord.com")) {
            return PauseMenuIconButton.Icon.DISCORD;
        }
        return null;
    }
}
