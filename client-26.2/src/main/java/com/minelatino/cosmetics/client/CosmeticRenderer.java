package com.minelatino.cosmetics.client;

import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.blaze3d.vertex.VertexConsumer;
import net.minecraft.client.model.player.PlayerModel;
import net.minecraft.client.model.player.PlayerCapeModel;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.renderer.SubmitNodeCollector;
import net.minecraft.client.renderer.rendertype.RenderTypes;
import net.minecraft.client.renderer.entity.RenderLayerParent;
import net.minecraft.client.renderer.entity.layers.RenderLayer;
import net.minecraft.client.renderer.entity.layers.CustomHeadLayer;
import net.minecraft.client.renderer.texture.OverlayTexture;
import org.joml.Quaternionf;
import net.minecraft.client.renderer.entity.state.AvatarRenderState;
import net.minecraft.resources.Identifier;
import net.minecraft.network.chat.Component;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.List;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Renders cosmetic overlays on players using 3D models (Blockbench JSON format).
 * Ported for Minecraft 1.21.11:
 *   PlayerRenderState -> AvatarRenderState
 *   PlayerModel -> net.minecraft.client.model.player.PlayerModel
 *   ResourceLocation -> Identifier
 *   RenderType -> RenderTypes (in rendertype subpackage)
 *   render() -> submit() with SubmitNodeCollector
 *   MultiBufferSource -> SubmitNodeCollector
 */
public final class CosmeticRenderer extends RenderLayer<AvatarRenderState, PlayerModel> {
    private static final Logger LOG = LoggerFactory.getLogger("MineLatino Cosmetics");

    static final Map<Integer, UUID> ENTITY_UUID_MAP = new ConcurrentHashMap<>();
    // submitEntityRenderState may retain or copy its state before the PIP pass.
    // Entity ID is the stable bridge between screen submission and layer render.
    private static final Map<Integer, CosmeticPreview.Frame> PREVIEW_FRAMES = new ConcurrentHashMap<>();
    private static int renderCallCount = 0;
    private final ResourceCache resourceCache;
    private final PlayerCapeModel capeModel = new PlayerCapeModel(PlayerCapeModel.createCapeLayer().bakeRoot());

    public CosmeticRenderer(RenderLayerParent<AvatarRenderState, PlayerModel> parent, ResourceCache resourceCache) {
        super(parent);
        this.resourceCache = resourceCache;
        LOG.info("[CosmeticRenderer] Layer constructed (1.21.11)");
        CosmeticsDiagnostics.event("LAYER_CREATED","CosmeticRenderer");
    }

    public static void putEntityUuid(int entityId, UUID uuid) {
        ENTITY_UUID_MAP.put(entityId, uuid);
    }

    /** True only while this entity has a MineLatino cape selected. */
    public static boolean shouldSuppressVanillaCape(int entityId) {
        UUID uuid = ENTITY_UUID_MAP.get(entityId);
        Minecraft minecraft = Minecraft.getInstance();
        if (minecraft.player != null && minecraft.player.getId() == entityId
                && CosmeticsClient.instance().auth().isConnected()
                && CosmeticsClient.instance().auth().session() != null) {
            try {
                uuid = UUID.fromString(formatUuid(CosmeticsClient.instance().auth().session().uuid()));
            } catch (IllegalArgumentException ignored) {}
        }
        return uuid != null && CosmeticsClient.instance().equipment()
                .hasEquippedSlot(uuid.toString(), "CAPE");
    }

    static void registerPreview(AvatarRenderState state, CosmeticPreview.Frame frame) {
        PREVIEW_FRAMES.put(state.id,frame);
    }

    @Override
    public void submit(PoseStack poseStack, SubmitNodeCollector collector, int packedLight,
                       AvatarRenderState renderState, float yaw, float partialTick) {
        renderCallCount++;
        if (shouldSuppressVanillaCape(renderState.id)) renderState.showCape = false;
        boolean local=Minecraft.getInstance().player!=null && Minecraft.getInstance().player.getId()==renderState.id;
        if (renderState.isInvisible || renderState.isSpectator) {
            if(local) CosmeticsDiagnostics.changed("WORLD_RENDER","skipped invisible="+renderState.isInvisible+" spectator="+renderState.isSpectator);
            return;
        }

        UUID afkUuid = ENTITY_UUID_MAP.get(renderState.id);
        if (CosmeticsClient.instance().afkIndicators().active(afkUuid)) {
            renderAfkBadge(poseStack, collector);
        }

        CosmeticPreview.Frame preview = PREVIEW_FRAMES.remove(renderState.id);
        List<EquipmentCache.EquippedItem> equipped;
        if (preview != null) {
            preview.layerVisited = true;
            CosmeticsDiagnostics.changed("PREVIEW_RENDER","layer active; items="+preview.items.size());
            equipped = preview.items;
        } else {
            UUID uuid = ENTITY_UUID_MAP.get(renderState.id);
            if (Minecraft.getInstance().player != null
                    && Minecraft.getInstance().player.getId() == renderState.id
                    && CosmeticsClient.instance().auth().isConnected()
                    && CosmeticsClient.instance().auth().session() != null) {
                try {
                    uuid = UUID.fromString(formatUuid(CosmeticsClient.instance().auth().session().uuid()));
                } catch (IllegalArgumentException ignored) {}
            }
            if (uuid == null) {
                if(local) CosmeticsDiagnostics.changed("WORLD_RENDER","missing entity UUID mapping");
                return;
            }
            equipped = CosmeticsClient.instance().equipment().get(uuid.toString());
        }
        if (equipped == null || equipped.isEmpty()) {
            if(local) CosmeticsDiagnostics.changed("WORLD_RENDER","no equipment in resolved UUID cache");
            return;
        }

        int submitted=0, pendingResources=0, unsupported=0;
        for (EquipmentCache.EquippedItem item : equipped) {
            if (CosmeticSlot.from(item.slot()).isEmpty()) { unsupported++; continue; }
            ResourceCache.CachedResource res = resourceCache.getOrDownload(item.cosmeticId());
            if (res == null || res.texture() == null) { pendingResources++; continue; }

            CosmeticModel model = res.model();
            if (model != null && !model.elements.isEmpty()) {
                renderModel(poseStack, collector, packedLight, renderState, res, model, item.slot(), item.cosmeticId(), preview != null);
                if(!model.quads.isEmpty()) submitted++;
            } else {
                renderFallback(poseStack, collector, packedLight, renderState, res.texture(), item.slot());
                submitted++;
            }
        }
        if(local) CosmeticsDiagnostics.changed("WORLD_RENDER","equipped="+equipped.size()+" submitted="+submitted+
                " resourcesUnavailable="+pendingResources+" unsupportedSlots="+unsupported);
    }

    private static String formatUuid(String value) {
        String hex = value.replace("-", "");
        if (!hex.matches("[0-9a-fA-F]{32}")) throw new IllegalArgumentException("invalid UUID");
        return hex.substring(0, 8) + "-" + hex.substring(8, 12) + "-" + hex.substring(12, 16)
                + "-" + hex.substring(16, 20) + "-" + hex.substring(20);
    }

    private static void renderAfkBadge(PoseStack poseStack, SubmitNodeCollector collector) {
        Minecraft minecraft = Minecraft.getInstance();
        String label = "AFK FARM";
        poseStack.pushPose();
        try {
            poseStack.translate(0, 3.1, 0);
            poseStack.mulPose(minecraft.getEntityRenderDispatcher().camera.rotation());
            poseStack.scale(-0.025f, -0.025f, 0.025f);
            collector.submitText(poseStack, -minecraft.font.width(label) / 2f, 0,
                    Component.literal(label).getVisualOrderText(), false, Font.DisplayMode.NORMAL,
                    0xFF55FFCC, 0, 0xF000F0, 0);
        } finally { poseStack.popPose(); }
    }

    private void renderModel(PoseStack poseStack, SubmitNodeCollector collector, int packedLight,
                             AvatarRenderState state, ResourceCache.CachedResource resource, CosmeticModel model, String slot, String cosmeticId,
                             boolean previewRender) {
        poseStack.pushPose();
        try {
            getParentModel().root().translateAndRotate(poseStack);
            if ("HAT".equals(slot)) {
                getParentModel().head.translateAndRotate(poseStack);
                CustomHeadLayer.translateToHead(poseStack, CustomHeadLayer.Transforms.DEFAULT);
                ApiClient.TransformData serverHead = CosmeticsClient.instance().getTransform(cosmeticId, "hat");
                if (serverHead != null) {
                    // Head slot: no X/Z negation — head bone translateAndRotate already produces Y-up space.
                    poseStack.translate(serverHead.translation()[0]/16, serverHead.translation()[1]/16, serverHead.translation()[2]/16);
                    poseStack.mulPose(new Quaternionf().rotationXYZ(
                            (float)Math.toRadians(serverHead.rotation()[0]),
                            (float)Math.toRadians(serverHead.rotation()[1]),
                            (float)Math.toRadians(serverHead.rotation()[2])));
                    poseStack.scale(serverHead.scale()[0], serverHead.scale()[1], serverHead.scale()[2]);
                } else {
                    CosmeticModel.DisplayTransform head = model.head;
                    poseStack.translate(head.translation()[0]/16, head.translation()[1]/16, head.translation()[2]/16);
                    poseStack.mulPose(new Quaternionf().rotationXYZ(
                            (float)Math.toRadians(head.rotation()[0]),
                            (float)Math.toRadians(head.rotation()[1]),
                            (float)Math.toRadians(head.rotation()[2])));
                    poseStack.scale(head.scale()[0], head.scale()[1], head.scale()[2]);
                }
            } else if ("PET".equals(slot)) {
                poseStack.translate(CosmeticPlacement.PET_X,
                        CosmeticPlacement.PET_Y + Math.sin(state.ageInTicks * 0.08) * 0.035,
                        CosmeticPlacement.PET_Z);
                poseStack.scale(CosmeticPlacement.PET_SCALE, -CosmeticPlacement.PET_SCALE, -CosmeticPlacement.PET_SCALE);
                poseStack.mulPose(new Quaternionf().rotationY(CosmeticPlacement.petYawRadians(previewRender)));
                ApiClient.TransformData serverPet = CosmeticsClient.instance().getTransform(cosmeticId, "pet");
                if (serverPet != null) applyDisplayTransform(poseStack, serverPet);
                applyPetAnimation(poseStack,resource.petAnimation(),petState(state, previewRender));
            } else {
                getParentModel().body.translateAndRotate(poseStack);
                poseStack.translate(0, 0.3, "BACKPACK".equals(slot) ? 0.30 : 0.16);
                poseStack.scale(1, -1, -1);
                // Keep 1.21.11 aligned with the 1.21.4 renderer for all back-mounted slots.
                poseStack.mulPose(new Quaternionf().rotationY(CosmeticPlacement.backFacingYawRadians(slot)));
                ApiClient.TransformData serverTransform = CosmeticsClient.instance().getTransform(cosmeticId, slot.toLowerCase());
                if (serverTransform != null) {
                    applyDisplayTransform(poseStack, serverTransform);
                } else if ("BACKPACK".equals(slot)) {
                        var b = model.backpack;
                        poseStack.translate(-b.translation()[0]/16,b.translation()[1]/16,-b.translation()[2]/16);
                        poseStack.mulPose(new Quaternionf().rotationXYZ((float)Math.toRadians(-b.rotation()[0]),(float)Math.toRadians(b.rotation()[1]),(float)Math.toRadians(-b.rotation()[2])));
                        poseStack.scale(b.scale()[0],b.scale()[1],b.scale()[2]);
                }
            }
            // Batch all faces sharing a texture. In the wardrobe, route them through
            // vanilla ModelPart submissions so the 1.21.11 PIP framebuffer and scissor
            // own the complete draw. World rendering keeps the lightweight custom path.
            Map<Identifier, List<CosmeticModel.Quad>> batches = new LinkedHashMap<>();
            for (CosmeticModel.Quad quad : model.quads) {
                var material = resource.materials().get(quad.texture());
                var texture = material == null ? resource.texture() : material.texture();
                CosmeticModel.Quad submittedQuad = quad;
                if (material != null && (material.animation().rows() != 1 || material.animation().columns() != 1)) {
                    var a = material.animation();
                    double ticks = System.nanoTime() / 50_000_000.0;
                    submittedQuad = new CosmeticModel.Quad(a.vertex(quad.v0(),ticks),a.vertex(quad.v1(),ticks),
                            a.vertex(quad.v2(),ticks),a.vertex(quad.v3(),ticks),quad.normal(),quad.texture());
                }
                batches.computeIfAbsent(texture, ignored -> new ArrayList<>()).add(submittedQuad);
            }
            for (var batch : batches.entrySet()) {
                List<CosmeticModel.Quad> quads = List.copyOf(batch.getValue());
                // The equipped world model already proves this exact geometry path.
                // Submit it unchanged inside the isolated GUI PIP pass instead of
                // converting its faces to ModelPart cubes (which remapped the atlas).
                collector.submitCustomGeometry(poseStack,
                        RenderTypes.entityCutout(batch.getKey()),
                        (pose, consumer) -> {
                            for (CosmeticModel.Quad quad : quads) renderQuad(consumer, pose, packedLight, quad);
                        });
            }
        } finally {
            poseStack.popPose();
        }
    }

    /** Applies a server-side transform after the back-facing base rotation. */
    private static void applyDisplayTransform(PoseStack poseStack, ApiClient.TransformData t) {
        poseStack.translate(-t.translation()[0]/16, t.translation()[1]/16, -t.translation()[2]/16);
        poseStack.mulPose(new Quaternionf().rotationXYZ(
                (float)Math.toRadians(-t.rotation()[0]),
                (float)Math.toRadians(t.rotation()[1]),
                (float)Math.toRadians(-t.rotation()[2])));
        poseStack.scale(t.scale()[0], t.scale()[1], t.scale()[2]);
    }

    private static PetAnimation.State petState(AvatarRenderState state, boolean previewRender) {
        if (previewRender) return PetAnimation.State.IDLE;
        if (state.attackTime > 0.01f) return PetAnimation.State.ATTACK;
        if (state.walkAnimationSpeed > 0.05f) return PetAnimation.State.WALK;
        return PetAnimation.State.IDLE;
    }

    private static void applyPetAnimation(PoseStack poseStack, PetAnimation animation, PetAnimation.State state) {
        var pose=animation.sample(state,System.nanoTime()/1_000_000_000.0);
        poseStack.translate(pose.position()[0]/16,pose.position()[1]/16,pose.position()[2]/16);
        poseStack.mulPose(new Quaternionf().rotationXYZ((float)Math.toRadians(pose.rotation()[0]),
                (float)Math.toRadians(pose.rotation()[1]),(float)Math.toRadians(pose.rotation()[2])));
        poseStack.scale(pose.scale()[0],pose.scale()[1],pose.scale()[2]);
    }

    private static void renderQuad(VertexConsumer consumer, PoseStack.Pose pose, int packedLight, CosmeticModel.Quad quad) {
        float[] n = quad.normal();
        addVertex(consumer, pose, quad.v0(), packedLight, n);
        addVertex(consumer, pose, quad.v1(), packedLight, n);
        addVertex(consumer, pose, quad.v2(), packedLight, n);
        addVertex(consumer, pose, quad.v3(), packedLight, n);
    }

    private static void addVertex(VertexConsumer consumer, PoseStack.Pose pose, float[] v, int light, float[] normal) {
        consumer.addVertex(pose, v[0], v[1], v[2])
                .setColor(255, 255, 255, 255)
                .setUv(v[3], v[4])
                .setOverlay(OverlayTexture.NO_OVERLAY)
                .setLight(light)
                .setNormal(pose, normal[0], normal[1], normal[2]);
    }

    private void renderFallback(PoseStack poseStack, SubmitNodeCollector collector, int packedLight,
                                AvatarRenderState state, Identifier texture, String slot) {
        if ("CAPE".equals(slot)) {
            poseStack.pushPose();
            try {
                if (!state.chestEquipment.isEmpty()) poseStack.translate(0,-0.053125f,0.06875f);
                collector.submitModel(capeModel,state,poseStack,RenderTypes.entitySolid(texture),packedLight,
                        OverlayTexture.NO_OVERLAY,state.outlineColor,null);
            } finally { poseStack.popPose(); }
            return;
        }
        poseStack.pushPose();
        getParentModel().root().translateAndRotate(poseStack);
        try { switch (slot) {
            case "HAT" -> collector.submitCustomGeometry(poseStack, RenderTypes.entityCutout(texture), (pose, c) -> {
                drawQuad(c, pose, packedLight, -0.3f, 0.3f, -0.3f, 0.0f, 0.0f, 1.0f, 0.0f, 1.0f, 0, 0, -1);
            });
            case "WINGS" -> collector.submitCustomGeometry(poseStack, RenderTypes.entityCutout(texture), (pose, c) -> {
                drawQuad(c, pose, packedLight, -0.35f, 0.0f, -0.3f, 0.3f, 0.0f, 0.5f, 0.0f, 1.0f, 0, 0, -1);
                drawQuad(c, pose, packedLight, 0.0f, 0.35f, -0.3f, 0.3f, 0.5f, 1.0f, 0.0f, 1.0f, 0, 0, -1);
            });
            case "BACKPACK", "PET" -> {
                if ("BACKPACK".equals(slot)) {
                    getParentModel().body.translateAndRotate(poseStack);
                    poseStack.translate(0, 0.3, 0.16);
                } else poseStack.translate(CosmeticPlacement.PET_X, CosmeticPlacement.PET_Y, CosmeticPlacement.PET_Z);
                collector.submitCustomGeometry(poseStack, RenderTypes.entityCutout(texture), (pose, c) -> {
                    drawQuad(c, pose, packedLight, -.22f, .22f, -.22f, .22f, 0, 1, 0, 1, 0, 0, -1);
                });
            }
        } } finally { poseStack.popPose(); }
    }

    private static void drawQuad(VertexConsumer consumer, PoseStack.Pose pose, int packedLight,
                                  float x1, float x2, float y1, float y2,
                                  float u1, float u2, float v1, float v2,
                                  int nx, int ny, int nz) {
        consumer.addVertex(pose, x1, y1, 0).setColor(255, 255, 255, 255).setUv(u1, v1).setOverlay(OverlayTexture.NO_OVERLAY).setLight(packedLight).setNormal(pose, nx, ny, nz);
        consumer.addVertex(pose, x1, y2, 0).setColor(255, 255, 255, 255).setUv(u1, v2).setOverlay(OverlayTexture.NO_OVERLAY).setLight(packedLight).setNormal(pose, nx, ny, nz);
        consumer.addVertex(pose, x2, y2, 0).setColor(255, 255, 255, 255).setUv(u2, v2).setOverlay(OverlayTexture.NO_OVERLAY).setLight(packedLight).setNormal(pose, nx, ny, nz);
        consumer.addVertex(pose, x2, y1, 0).setColor(255, 255, 255, 255).setUv(u2, v1).setOverlay(OverlayTexture.NO_OVERLAY).setLight(packedLight).setNormal(pose, nx, ny, nz);
    }
}
