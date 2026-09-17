package com.minelatino.cosmetics.client;

import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

/** Drag-and-drop editor for MineLatino HUD modules. */
public final class HudEditorScreen extends Screen {
    private final Screen parent;
    private final String selectedId;
    private final boolean panelVisible;
    private String dragging;
    private double dragOffsetX;
    private double dragOffsetY;

    public HudEditorScreen(Screen parent) {
        this(parent, null, true);
    }

    private HudEditorScreen(Screen parent, String selectedId, boolean panelVisible) {
        super(Component.literal("Personalizar HUD"));
        this.parent = parent;
        this.selectedId = selectedId;
        this.panelVisible = panelVisible;
    }

    @Override protected void init() {
        HudConfig config = config();
        int panelWidth = Math.min(246, Math.max(120, width - 8));
        int panelX = Math.max(4, width - panelWidth - 4);
        addRenderableWidget(new HudButton(width - 24, 6, 20, 18,
                panelVisible ? ">" : "<", this::togglePanel, () -> panelVisible));
        if (!panelVisible) return;
        int x = panelX + 4;
        int contentWidth = panelWidth - 8;
        int bottomY = Math.max(48, height - 27);
        if (selectedId != null && HudConfig.ORDER.contains(selectedId)) {
            initWidgetEditor(config, x, contentWidth, bottomY);
            return;
        }

        int y = 28;
        int rowHeight = Math.max(16, Math.min(22, (bottomY - y - 5) / HudConfig.ORDER.size()));
        for (String id : HudConfig.ORDER) {
            HudConfig.Widget widget = config.widget(id);
            addRenderableWidget(new HudButton(x, y, contentWidth, rowHeight - 2,
                    (widget.enabled() ? "✓  " : "○  ") + name(id) + "   ›", () -> reopen(id), widget::enabled));
            y += rowHeight;
        }
        int half = (contentWidth - 6) / 2;
        addRenderableWidget(new HudButton(x, bottomY, half, 20, "Restablecer HUD", () -> {
            config.reset();
            reopen(null);
        }, () -> false));
        addRenderableWidget(new HudButton(x + half + 6, bottomY, contentWidth - half - 6, 20,
                "Volver", this::onClose, () -> false));
    }

    private void initWidgetEditor(HudConfig config, int x, int contentWidth, int bottomY) {
        HudConfig.Widget widget = config.widget(selectedId);
        int y = 28;
        int controls = HudConfig.supportsLayout(selectedId) ? 7 : 6;
        int rowHeight = Math.max(16, Math.min(22, (bottomY - y - 5) / controls));
        int buttonHeight = rowHeight - 2;

        addRenderableWidget(new HudButton(x, y, contentWidth, buttonHeight,
                widget.enabled() ? "Visible en el HUD" : "Oculto en el HUD", () -> {
            config.toggle(selectedId); reopen(selectedId);
        }, widget::enabled));
        y += rowHeight;
        if (HudConfig.supportsLayout(selectedId)) {
            addRenderableWidget(new HudButton(x, y, contentWidth, buttonHeight,
                    "Formato: " + (HudConfig.VERTICAL.equals(widget.layout()) ? "Vertical" : "Horizontal"), () -> {
                config.toggleLayout(selectedId); reopen(selectedId);
            }, () -> HudConfig.VERTICAL.equals(config.widget(selectedId).layout())));
            y += rowHeight;
        }
        addRenderableWidget(new HudButton(x, y, contentWidth, buttonHeight,
                "Fondo: " + (widget.showBackground() ? "Visible" : "Sin fondo"), () -> {
            config.toggleBackground(selectedId); reopen(selectedId);
        }, widget::showBackground));
        y += rowHeight;
        addRenderableWidget(new HudButton(x, y, contentWidth, buttonHeight,
                "Borde: " + (widget.showBorder() ? "Visible" : "Sin borde"), () -> {
            config.toggleBorder(selectedId); reopen(selectedId);
        }, widget::showBorder));
        y += rowHeight;
        addRenderableWidget(new HudButton(x, y, contentWidth, buttonHeight,
                "Color: " + HudConfig.backgroundName(widget.background()), () -> {
            config.nextBackground(selectedId); reopen(selectedId);
        }, () -> false));
        y += rowHeight;
        addStepper(config, x, y, contentWidth, buttonHeight, "Opacidad", widget.opacity(), false);
        y += rowHeight;
        addStepper(config, x, y, contentWidth, buttonHeight, "Tamaño", widget.scale(), true);

        int half = (contentWidth - 6) / 2;
        addRenderableWidget(new HudButton(x, bottomY, half, 20, "‹ Módulos", () -> reopen(null), () -> false));
        addRenderableWidget(new HudButton(x + half + 6, bottomY, contentWidth - half - 6, 20,
                "Volver", this::onClose, () -> false));
    }

    private void addStepper(HudConfig config, int x, int y, int width, int height,
                            String label, int value, boolean scale) {
        int side = Math.max(28, width / 5);
        addRenderableWidget(new HudButton(x, y, side, height, "−", () -> {
            if (scale) config.adjustScale(selectedId, -10); else config.adjustOpacity(selectedId, -10);
            reopen(selectedId);
        }, () -> false));
        addRenderableWidget(new HudButton(x + side + 3, y, width - side * 2 - 6, height,
                label + ": " + value + "%", () -> {}, () -> false));
        addRenderableWidget(new HudButton(x + width - side, y, side, height, "+", () -> {
            if (scale) config.adjustScale(selectedId, 10); else config.adjustOpacity(selectedId, 10);
            reopen(selectedId);
        }, () -> false));
    }

    @Override public void renderBackground(GuiGraphics graphics, int mouseX, int mouseY, float delta) {
        // Keep the game visible so players can preview the final HUD placement.
    }

    @Override public void render(GuiGraphics graphics, int mouseX, int mouseY, float delta) {
        renderBackground(graphics, mouseX, mouseY, delta);
        HudOverlay.render(graphics, true);
        int panelWidth = Math.min(246, Math.max(120, width - 8));
        int panelX = Math.max(4, width - panelWidth - 4);
        if (panelVisible) HudButton.panel(graphics, panelX, 4, panelWidth, Math.max(1, height - 8), 0xFF31515D, 0xE611171D);
        super.render(graphics, mouseX, mouseY, delta);
        if (panelVisible) {
            String heading = selectedId == null ? "Personalizar HUD" : "Editar · " + name(selectedId);
            graphics.drawCenteredString(font, heading, panelX + panelWidth / 2, 11, 0xFFA8F3FF);
            if (width - panelWidth > 170) graphics.drawString(font,
                    "Arrastra los módulos · selecciona uno para editar su aspecto", 8, height - 14, 0xFFA8B2BC, false);
        }
    }

    @Override public boolean mouseClicked(double mouseX, double mouseY, int button) {
        if (super.mouseClicked(mouseX, mouseY, button)) return true;
        if (button == 0) {
            HudOverlay.Bounds bounds = HudOverlay.at(mouseX, mouseY);
            if (bounds != null) {
                dragging = bounds.id();
                dragOffsetX = mouseX - bounds.x();
                dragOffsetY = mouseY - bounds.y();
                return true;
            }
        }
        return false;
    }

    @Override public boolean mouseDragged(double mouseX, double mouseY, int button, double dx, double dy) {
        if (dragging != null && button == 0) {
            config().move(dragging, (int)Math.round(mouseX - dragOffsetX), (int)Math.round(mouseY - dragOffsetY));
            return true;
        }
        return super.mouseDragged(mouseX, mouseY, button, dx, dy);
    }

    @Override public boolean mouseReleased(double mouseX, double mouseY, int button) {
        if (dragging != null) {
            config().save();
            dragging = null;
            return true;
        }
        return super.mouseReleased(mouseX, mouseY, button);
    }

    @Override public void onClose() {
        config().save();
        minecraft.setScreen(parent);
    }

    private HudConfig config() {
        return HudConfig.get(minecraft.gameDirectory.toPath());
    }

    private void reopen(String id) { minecraft.setScreen(new HudEditorScreen(parent, id, panelVisible)); }

    private void togglePanel() { minecraft.setScreen(new HudEditorScreen(parent, selectedId, !panelVisible)); }

    private static String name(String id) {
        return switch (id) {
            case HudConfig.FPS -> "FPS";
            case HudConfig.COORDINATES -> "Coordenadas";
            case HudConfig.CPS -> "CPS";
            case HudConfig.ARMOR -> "Armadura";
            case HudConfig.EFFECTS -> "Efectos";
            case HudConfig.COMPASS -> "Brújula";
            case HudConfig.INPUT -> "Teclas y mouse";
            default -> id;
        };
    }
}
