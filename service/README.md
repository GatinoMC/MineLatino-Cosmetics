# API local de cosméticos

Backend del panel, catálogo, recursos, cuentas, entregas y sincronización del mod.
Publicar metadatos no genera un modelo: los recursos se cargan explícitamente.

## Iniciar

Requiere Node **24.12.x o posterior de la rama 24**. No hay dependencias npm externas.
`node:sqlite` aún emite un aviso experimental en esta versión de Node; fijar y probar
el runtime antes de desplegar. La API de referencia es
[node:sqlite](https://nodejs.org/api/sqlite.html).

1. Crear `.env` a partir de `.env.example` dentro de esta carpeta.
2. Configurar `COSMETICS_ADMIN_TOKEN` con una clave aleatoria privada de 32 caracteres
   o más. No existe una clave predeterminada ni una cuenta pública.
3. Ejecutar `npm start` desde esta carpeta. Escucha **solo en 127.0.0.1:8787**.
4. `GET /health` comprueba disponibilidad. Las rutas administrativas exigen
   `Authorization: Bearer <clave privada>`.

Los datos se guardan en `data/cosmetics.sqlite` (ignorado por Git). El archivo y
sus posibles archivos WAL/SHM son privados. Para la copia de seguridad de desarrollo,
detener el servicio antes de copiar la base. No borrar una base existente para actualizar.
La API usa sentencias preparadas, claves foráneas y transacciones.

La clave es un bootstrap de **un único administrador local**, identificado en la
auditoría como `local-admin`; no implementa todavía cuentas administrativas ni roles.
No publicar este proceso mediante un túnel. Antes de hosting: TLS, identidad y roles
administrativos, permisos de archivos, copias verificadas y operación multiinstancia.

## Rutas implementadas

| Método / ruta | Función |
|---|---|
| GET `/v1/cosmetics/catalog?offset=0` | Metadatos publicados, hasta 50 |
| GET `/v1/cosmetics/appearance?uuids=<uuid>,<uuid>` | Equipamiento público, máximo 50 UUID |
| GET `/v1/cosmetics/emotes?uuids=<uuid>&names=<nick>` | Emotes activos de jugadores cercanos |
| GET `/v1/launcher/playtime-leaderboard` | Horas registradas y todas las cuentas activas, incluidas las de 0 horas |
| GET `/v1/afk/active-players` | UUIDs con sesión AFK Farm vigente para el distintivo temporal del mod |
| POST `/v1/account/emote` | Emitir un emote autenticado de la Skin equipada |
| GET `/v1/client-config/pause-menu` | Última configuración válida y revisión |
| GET `/v1/admin/cosmetics/catalog?offset=0` | Catálogo completo paginado |
| PUT `/v1/admin/cosmetics/catalog/<id>` | Crear o actualizar, con `expectedRevision` |
| POST `/v1/admin/cosmetics/grants` | Asignar un artículo por UUID |
| POST `/v1/admin/cosmetics/revocations` | Revocar y quitar equipamiento en la misma transacción |
| GET `/v1/admin/cosmetics/owners/<id>?offset=0` | Propietarios activos y último nick verificado |
| GET `/v1/admin/audit?offset=0` | Historial administrativo |
| PUT `/v1/admin/pause-menu` | Publicar una revisión de menú |
| GET `/v1/admin/pause-menu/history?offset=0` | Historial de configuración |
| POST `/v1/admin/pause-menu/restore` | Recuperar una revisión publicando una nueva |
| POST `/v1/account/password/forgot` | Solicitar un código sin revelar si el correo existe |
| POST `/v1/account/password/reset` | Consumir el código y definir una contraseña nueva |
| PUT `/v1/account/password` | Cambiarla con sesión y contraseña actual |
| POST `/v1/admin/player-accounts/<id>/password-reset` | Generar un código de soporte de un solo uso |
| DELETE `/v1/admin/player-accounts/<id>` | Eliminar permanentemente una cuenta y liberar su correo/nick |
| POST `/v1/ai/token` | Canjear una sesión vinculada por un token IA de 10 minutos |
| GET `/v1/ai/status` | Consultar disponibilidad y límites con token IA |
| POST `/v1/ai/chat` | Enviar un mensaje idempotente en una conversación de la cuenta |
| POST `/v1/ai/logout` | Revocar el token IA actual |

`PLAYTIME_BACKEND_URL` permite configurar el origen del contador de horas; por
defecto usa el backend MineLatino publicado. Si ese origen falla, la clasificación
devuelve error en lugar de presentar horas incorrectas como cero.

## Asistente IA privado

De forma predeterminada, el asistente del juego usa `AI_SOURCE=minelatino-web` y
consulta el mismo chat oficial publicado en `https://minelatino.net/asistente`. El
servicio obtiene una sesión CSRF anónima para cada mensaje, envía la pregunta junto
con los últimos seis mensajes y nunca entrega esa cookie temporal al mod.

`MINELATINO_ASSISTANT_URL` permite cambiar únicamente el origen HTTPS oficial.
`AI_REQUEST_TIMEOUT_SECONDS`, `AI_MAX_MESSAGE_CHARS`, `AI_MAX_CONTEXT_MESSAGES` y
`AI_DAILY_REQUEST_LIMIT` son límites operativos opcionales.

El modo anterior de proveedor directo se conserva solamente como alternativa. Para
activarlo configura `AI_SOURCE=direct`, `AI_PROVIDER=openai`, `AI_API_KEY` y
`AI_MODEL` únicamente en el entorno privado del servicio.

Para un proveedor OpenAI-compatible directo usa `AI_PROVIDER=openai-compatible`, una
`AI_BASE_URL` HTTPS terminada normalmente en `/v1` y
`AI_API_STYLE=chat-completions`. La URL se valida al iniciar; no puede incluir
credenciales, query ni fragmento. La clave continúa exclusivamente en Railway.

El token de cuenta o juego sirve sólo para solicitar una credencial efímera; no puede
llamar directamente a chat. La credencial resultante usa exclusivamente
`Authorization: Bearer`, tiene el alcance `ai:chat`, está enlazada a la sesión padre
y deja de funcionar al cerrar sesiones, suspender/eliminar la cuenta o reiniciar el
servicio. Conversaciones, mensajes y consumo se almacenan por
`accountId`; un `requestId` evita cobros y respuestas duplicadas.

## Tiempo de AFK Farm

El panel **AFK Farm** permite buscar una cuenta MineLatino, añadir tiempo, establecer
un saldo exacto o dejarlo en cero. Los cambios quedan en la auditoría. Una cuenta nueva
empieza con cero segundos y no puede iniciar el flujo hasta recibir tiempo.

El mod canjea su sesión vinculada en `POST /v1/afk/token` por una credencial persistente
de 15 minutos con alcance exclusivo `afk:usage`. La credencial sobrevive reinicios del
servicio, se renueva antes de caducar y se revoca junto con su sesión padre. Consulta el saldo mediante
`GET /v1/afk/status` y abre una sesión exclusiva en `POST /v1/afk/sessions`. Mientras
la automatización está activa llama al heartbeat cada 20 segundos. El backend calcula
el tiempo transcurrido con su propio reloj, limita a 60 segundos el cargo de una
renovación aislada y bloquea nuevas sesiones cuando el saldo se agota. Ninguna ruta
de cliente acepta segundos consumidos ni una identidad enviada en el cuerpo.

## Recuperación de cuentas

Los códigos tienen 12 caracteres, caducan a los 15 minutos, se guardan únicamente
como SHA-256 y dejan de funcionar después del primer uso. Al cambiar la contraseña
se cierran todas las sesiones del launcher y del mod. La respuesta pública de
solicitud es idéntica exista o no el correo para evitar enumerar cuentas.

Configura `COSMETICS_RESEND_API_KEY` y `COSMETICS_EMAIL_FROM` para enviar el código
por correo mediante Resend. Sin esas variables, el administrador puede buscar la
cuenta en el panel, pulsar **Recuperar acceso** y entregar el código al propietario
después de verificarlo por el canal de soporte habitual.

Los listados avanzan sumando el número de resultados a `offset`; una página con
menos de 50 resultados es la última. No se expone información de compradores en
el catálogo público. Los UUID se normalizan a 32 caracteres hexadecimales sin guiones.

Creación de metadatos (`PUT .../catalog/capa-fundador`):

```json
{"name":"Capa fundador","slot":"CAPE","status":"draft","expectedRevision":0}
```

Slots: `CAPE`, `HAT`, `WINGS`, `BACKPACK`, `PET`. Estados: `draft`, `published`, `retired`.

El sistema de personajes/skins 3D fue retirado. Los productos SKIN anteriores
quedan retirados y fuera de catálogos, armarios, entregas y distribución de recursos.
Los registros históricos y archivos se conservan para no destruir compras anteriores.
Una actualización usa la revisión recibida; un conflicto devuelve 409.
El slot es inmutable para evitar que un artículo vendido cambie de categoría.
Cambiar nombre o estado no elimina las asignaciones existentes. Retirarlo sí
quita el equipamiento público, preservando la propiedad.

Entrega o revocación:

```json
{"uuid":"1234567890abcdef1234567890abcdef","cosmeticId":"capa-fundador","reference":"manual-unique-1","reason":"Entrega administrativa"}
```

La referencia identifica una operación, no una compra verificada. Repetir exactamente
la misma operación no cambia nada; reutilizar su referencia para otra operación
devuelve 409. Una nueva entrega tras revocación exige una referencia nueva.
Una asignación manual a un UUID **no acredita que sea premium**. Si aún no hay
verificación, el nick y `verified_at` aparecen como `null`; el jugador no puede
abrir una sesión cosmética hasta demostrar esa identidad ante Mojang.

Menú: `{"expectedRevision":0,"config":{...}}`, usando el esquema del mod.
Restauración: `{"expectedRevision":2,"revision":1}`. Conserva todas las revisiones.

## Vinculación premium obligatoria

Está activada por defecto e integrada en los JAR. El servicio no contiene un
bypass por UUID o nickname. `COSMETICS_ENABLE_PREMIUM=false` detiene el inicio
de sesión de jugadores, pero nunca habilita cuentas offline.

El flujo es:

1. POST `/v1/auth/challenge` con `{"username":"NombreMinecraft"}`.
2. El mod llama a `MinecraftSessionService.joinServer` de authlib con su sesión de
   Minecraft y el `serverId` recibido. La credencial de Microsoft/Minecraft no se
   envía a este backend. Hacerlo como paso explícito de vinculación, coordinado
   con la conexión al servidor de juego, no repetidamente por frame.
3. POST `/v1/auth/verify` con `{"challengeId":"..."}`. El backend consulta solamente
   `https://sessionserver.mojang.com/session/minecraft/hasJoined` y comprueba el nombre.
4. Devuelve una sesión opaca de 15 minutos vinculada al UUID confirmado. Se guarda
   únicamente su hash en memoria; reiniciar el servicio invalida todas las sesiones.
5. GET `/v1/cosmetics/me/wardrobe` con Bearer de jugador consulta su inventario.
6. PUT `/v1/cosmetics/me/equipment` con `{"slot":"CAPE","cosmeticId":"capa-fundador"}`
   equipa si existe propiedad activa y el cosmético está publicado. `null` quita el slot.
7. POST `/v1/auth/logout` invalida la sesión.

No hay parámetro UUID que permita elegir otro propietario al equipar. Los desafíos
caducan en 60 segundos y se consumen antes de consultar Mojang, incluso si la
consulta falla. Para reintentar se pide uno nuevo. `/v1/auth/offline` siempre
responde `403`, incluso cuando la autenticación premium está detenida.

## Límites de la entrega

- 120 solicitudes por minuto y dirección, sin confiar en `X-Forwarded-For`.
- 16 KiB por cuerpo JSON; metadatos limitados y URLs del menú restringidas.
- Sin cookies ni CORS abierto; un futuro panel debe integrarse deliberadamente.
- Menú global: aún no distingue servidor, ni distribuye la configuración al mod.
- Sin assets, pago, roles, login web ni renderizado de accesorios.
- SQLite de un solo proceso local; las migraciones de futuras versiones deben
  preservar la base y comprobar `user_version` antes de introducir cambios.

## Verificación

`npm run check` y `npm test`: 23 pruebas sin red externa. Cubren permisos, replay,
caducidad, revocación, propiedad, paginación, persistencia, edición concurrente,
historial y transporte HTTP real en un puerto local efímero. El servidor de prueba
se cierra y solo se elimina su directorio temporal de datos.
