# mensajeria-service

Microservicio Node.js separado para enviar mensajes por WhatsApp, Telegram y Gmail mediante endpoints REST simples.

## Stack

- `express@5.1.0`
- `dotenv@16.4.5`
- `@whiskeysockets/baileys@6.7.20`
- `grammy@1.38.3`
- `pino@9.7.0`
- `qrcode@1.5.4`

## Estructura

```text
mensajeria-service/
  .env.example
  .gitignore
  nodemon.json
  package.json
  package-lock.json
  README.md
  index.js
  routes/
    gmail.js
    health.js
    telegram.js
    whatsapp.js
  services/
    gmailAccountStore.js
    gmailService.js
    telegramService.js
    whatsappService.js
  utils/
    delay.js
    phone.js
  public/
    wa-login.html
  data/
  vendor/
  wa_auth/
```

## Instalacion

```bash
npm install
```

## Variables de entorno

Crear `.env` a partir de `.env.example`:

```env
PORT=3001
TELEGRAM_BOT_TOKEN=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3002/gmail/oauth/callback
GMAIL_TOKEN_ENCRYPTION_KEY=
GMAIL_OAUTH_STATE_SECRET=
```

Si tenes otro servicio usando `3001`, cambiá `PORT` en tu `.env`.

## Inicio

Modo normal:

```bash
npm start
```

Modo desarrollo con recarga:

```bash
npm run dev
```

## Endpoints principales

### Health

`GET /health`

```json
{
  "ok": true,
  "service": "mensajeria-service"
}
```

### Home

`GET /`

Devuelve estado general del servicio, endpoints y estado de WhatsApp y Telegram.

## WhatsApp

Base: `/whatsapp`

### Modos de funcionamiento

El servicio conserva el modo original mientras esta variable no sea `true`:

```env
WHATSAPP_MULTI_INSTANCE_ENABLED=false
```

Con el valor `false`, los endpoints existentes mantienen su comportamiento y
continuan usando la sesion `wa_auth/`.

Con el valor `true`:

- No existe una instancia predeterminada.
- Cada envio debe indicar `instancia`.
- Cada instancia tiene su propia sesion dentro de `wa_instances/`.
- La vinculacion se realiza mediante codigo telefonico, no mediante QR.
- El numero conectado debe coincidir con el numero configurado.

La version de Baileys y las dependencias de señal estan congeladas. No ejecutar
una actualizacion de dependencias como parte de la activacion de este modo.

### Estado

`GET /whatsapp/estado`

### QR

`GET /whatsapp/qr`

### Login HTML

`GET /whatsapp/login`

Abrí esa URL para escanear el QR.

### Envio secuencial

`POST /whatsapp/enviar-sync`

Ejemplo:

```bash
curl -X POST http://localhost:3002/whatsapp/enviar-sync ^
  -H "Content-Type: application/json" ^
  -d "{\"destinos\":[{\"numero\":\"1122334455\",\"nombre\":\"Juan\"}],\"mensaje\":\"Hola {nombre}, este es un mensaje de prueba.\",\"pausa\":3500}"
```

En modo multi-instancia, `instancia` es obligatoria:

```json
{
  "instancia": "LOGISTICA",
  "destinos": [
    {
      "numero": "5491112345678",
      "nombre": "Juan"
    }
  ],
  "mensaje": "Hola {nombre}",
  "eliminarCopia": true
}
```

`eliminarCopia` es opcional y por defecto es `false`. Cuando vale `true`, el
servicio elimina la copia del mensaje en el WhatsApp emisor despues de
enviarlo. No revoca ni elimina el mensaje recibido por el destinatario.

### Administracion de instancias

Panel:

`GET /whatsapp/panel`

Endpoints:

- `GET /whatsapp/instancias`
- `POST /whatsapp/instancias`
- `GET /whatsapp/instancias/:id`
- `POST /whatsapp/instancias/:id/vincular`
- `GET /whatsapp/instancias/:id/vinculacion`
- `POST /whatsapp/instancias/:id/reconectar`
- `GET /whatsapp/instancias/:id/mensajes?desde=AAAA-MM-DD&hasta=AAAA-MM-DD&chatId=JID`
- `GET /whatsapp/instancias/:id/chats`
- `GET /whatsapp/instancias/:id/configuracion-registro`
- `PUT /whatsapp/instancias/:id/configuracion-registro`
- `DELETE /whatsapp/instancias/:id/mensajes`
- `POST /whatsapp/instancias/:id/resincronizar-contactos`
- `GET /whatsapp/modelos-ia`
- `POST /whatsapp/instancias/:id/analizar-bandeja`
- `GET /whatsapp/instancias/:id/grupos`
- `GET /whatsapp/instancias/:id/grupos/:groupId` (detalle completo y Group ID)
- `POST /whatsapp/instancias/:id/enviar-sync`
- `POST /whatsapp/instancias/:id/enviar`
- `DELETE /whatsapp/instancias/:id`

Ejemplo de alta:

```json
{
  "nombre": "LOGISTICA",
  "numero": "+5492245558702"
}
```

Los nombres se normalizan a mayusculas y deben ser unicos. Un mismo numero no
puede pertenecer a dos instancias.

El panel incluye una bandeja de mensajes por instancia con filtro de fechas,
conversaciones, enviados, recibidos y tiempo promedio de respuesta. Solo
aparecen los mensajes capturados desde que el servicio esta ejecutandose con el
almacenamiento habilitado; no se importa el historial anterior de WhatsApp.
La bandeja conserva los contactos sincronizados por Baileys, muestra primero el
nombre agendado (o, como alternativa, el nombre de perfil) y usa las asociaciones
LID/telefono recibidas por WhatsApp para evitar presentar un LID como si fuera un
numero telefonico.
Los nombres de los grupos se sincronizan al conectar cada instancia, se conservan
en SQLite y se actualizan cuando WhatsApp informa cambios en sus metadatos.
`GET /whatsapp/instancias/:id/chats` lista los contactos y grupos conocidos en
SQLite para construir selectores externos. La consulta de mensajes acepta
`chatId` de forma opcional y repetible; sin ese parametro conserva el
comportamiento de devolver todos los chats del periodo. Cuando se incluyen uno
o varios `chatId`, tanto las conversaciones como las metricas se calculan
unicamente sobre esos chats. Se admiten hasta 100 por solicitud.
En mensajes grupales se conserva `participante` y, cuando WhatsApp o la agenda
permiten resolverlos, se agregan `telefonoParticipante` y
`nombreParticipante`. El identificador original queda disponible como respaldo
cuando no existe un nombre o telefono real conocido.
Cada instancia puede definir si registra todos los mensajes nuevos, solamente
los contactos y grupos seleccionados, o ninguno. La configuracion no elimina el
historial existente y, si todavia no fue definida, conserva el comportamiento
anterior de registrar todo.
La misma configuracion permite conservar los mensajes sin vencimiento o durante
un plazo por instancia. La limpieza se ejecuta al abrir el almacenamiento y luego
una vez por dia, usando el indice por instancia y fecha. El panel tambien permite
vaciar manualmente una bandeja completa escribiendo el identificador exacto de la
instancia; esta accion no elimina contactos, grupos ni la configuracion.
Si una sesion existente no vuelve a emitir su agenda al reconectarse, el boton
`Sincronizar contactos` solicita de forma explicita una nueva instantanea de la
coleccion de contactos, sin desvincular el numero. Si la sincronizacion falla, se
restaura la version anterior de esa coleccion.

La accion `Analizar bandeja` clasifica el motivo de cada conversacion, evalua
la atencion, calcula la primera respuesta y muestra cuantos audios e imagenes no
pudieron interpretarse. Si Gemini no esta configurado, devuelve igualmente una
evaluacion basica basada en tiempos, respuestas y palabras clave.

El selector del análisis muestra únicamente los modelos habilitados en
`/ia/panel`. El elegido se intenta primero para ese análisis y, ante cuota
agotada, saturación o indisponibilidad temporal, API Mensajería continúa con los
demás modelos según la prioridad central.

### Envio en background

`POST /whatsapp/enviar`

Responde enseguida con un `jobId` y procesa el lote en segundo plano.

## Telegram

Base: `/telegram`

Panel de estado y endpoints: `GET /telegram/panel`

### Estado

`GET /telegram/estado`

### Envio secuencial

`POST /telegram/enviar-sync`

Ejemplo:

```bash
curl -X POST http://localhost:3002/telegram/enviar-sync ^
  -H "Content-Type: application/json" ^
  -d "{\"destinos\":[{\"chatId\":\"123456789\",\"nombre\":\"Jorge\"}],\"mensaje\":\"Hola {nombre}, este es un aviso automatico.\",\"pausa\":1000}"
```

## Gmail

Base: `/gmail`

Cada cuenta se vincula con OAuth 2.0 y queda asociada a una identificacion
interna, por ejemplo `ADMINISTRACION`, `PERSONAL` o `VENTAS`. El servicio solo
guarda el `refresh_token` cifrado; la aplicacion consumidora conserva los IDs de
mensajes y conversaciones.

### Configuracion en Google Cloud

1. Crear un proyecto y habilitar Gmail API.
2. Configurar la pantalla de consentimiento OAuth.
3. Crear un cliente OAuth de tipo Aplicacion web.
4. Registrar `http://localhost:3002/gmail/oauth/callback` como URI de
   redireccion autorizada para desarrollo.
5. Copiar el Client ID y Client Secret al `.env`.
6. Generar dos secretos aleatorios diferentes, de al menos 32 caracteres, para
   `GMAIL_TOKEN_ENCRYPTION_KEY` y `GMAIL_OAUTH_STATE_SECRET`.

Con Node.js se pueden generar los secretos con:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### Vincular una cuenta

Abrir el administrador en el navegador:

```text
http://localhost:3002/gmail/panel
```

Desde ahi se pueden agregar y desvincular cuentas. El alta abre Google OAuth y
vuelve automaticamente al panel.

Tambien se puede iniciar directamente una vinculacion:

```text
http://localhost:3002/gmail/oauth/iniciar?identificacion=VENTAS
```

Opcionalmente se puede sugerir una cuenta concreta:

```text
http://localhost:3002/gmail/oauth/iniciar?identificacion=VENTAS&email=ventas@gmail.com
```

Google vuelve al callback y el servicio guarda la cuenta autorizada. Las
identificaciones se normalizan a mayusculas y deben ser unicas.

### Estado y cuentas

- `GET /gmail/estado`
- `GET /gmail/panel`
- `GET /gmail/cuentas`
- `GET /gmail/oauth/url?identificacion=VENTAS`
- `DELETE /gmail/cuentas/:identificacion`

El listado nunca devuelve refresh tokens.

### Enviar

`POST /gmail/enviar`

```json
{
  "identificacion": "VENTAS",
  "para": "cliente@ejemplo.com",
  "asunto": "Consulta comercial",
  "texto": "Hola, este es un mensaje de prueba."
}
```

Tambien acepta `html`, `cc` y `bcc`. La respuesta incluye:

```json
{
  "ok": true,
  "canal": "gmail",
  "identificacion": "VENTAS",
  "cuenta": "ventas@gmail.com",
  "gmailMessageId": "...",
  "gmailThreadId": "...",
  "rfcMessageId": "<...@gmail.com>"
}
```

La aplicacion consumidora debe guardar esos identificadores.

### Responder en la misma conversacion

Para que Gmail agregue el mensaje al mismo hilo, enviar el `threadId`, el
`inReplyTo` y las referencias guardadas por la aplicacion consumidora. El asunto
debe coincidir con el de la conversacion.

```json
{
  "identificacion": "VENTAS",
  "para": "cliente@ejemplo.com",
  "asunto": "Re: Consulta comercial",
  "texto": "Esta es la respuesta.",
  "threadId": "gmail-thread-id",
  "inReplyTo": "<mensaje-anterior@dominio>",
  "references": [
    "<mensaje-inicial@dominio>",
    "<mensaje-anterior@dominio>"
  ]
}
```

## Procesamiento con Gemini

La clave se configura solo en el servidor, dentro de `.env`:

```env
GEMINI_API_KEY=tu_clave_de_google_ai_studio
```

No se debe enviar `GEMINI_API_KEY` desde el navegador ni incluirla en una
solicitud. El archivo `.env` esta excluido de Git.

Opcionalmente se puede proteger la ruta para los sistemas consumidores:

```env
IA_API_KEY=una_clave_interna_distinta
FIREBIRD_API_URL=http://localhost:3000
FIREBIRD_API_KEY=una_clave_tecnica_para_consumir_api_firebird
```

Si se configura, cada llamada debe incluir `X-API-Key` o
`Authorization: Bearer ...`.

El panel abierto desde `localhost` o desde una direccion de red privada obtiene
una sesion `HttpOnly` firmada por el servidor. De esta forma puede usar la clave
configurada en `.env` sin exponerla al navegador. Las llamadas externas a la API
siguen necesitando `X-API-Key` o `Authorization`.

La consola `/ia/panel` permite ordenar y guardar los modelos Gemini habilitados,
además de iniciar conversaciones en texto o JSON y, para JSON, enviar
opcionalmente un `esquemaRespuesta`. Al crearse el chat bloquea los stores, el
formato y el esquema porque quedan asociados a la conversación. Las aclaraciones
y turnos posteriores envían solamente `chatId` y `respuesta`, sin volver a
transferir el contenido ni los archivos iniciales. La acción `Nueva conversación`
libera esas opciones y descarta el `chatId` del panel.

La prioridad se persiste en `data/gemini-models.json` mediante reemplazo atómico.
El primer elemento es el modelo principal y los siguientes son alternativas en el
orden exacto en que se intentarán. Si todavía no existe configuración guardada se
usan, en este orden, `gemini-3.6-flash`, `gemini-3.5-flash` y
`gemini-3.5-flash-lite`.

El combo de prompts del panel consulta `GET /ia/prompts`. API Mensajería no se
conecta a Firebird: usa `FIREBIRD_API_URL` y envía `FIREBIRD_API_KEY` únicamente
desde el backend al endpoint interno de API Firebird. Al elegir un prompt vigente,
su texto se copia al campo Prompt y continúa siendo editable; también se puede
escribir manualmente.

### Estado

`GET /ia/estado`

Informa si Gemini está configurado, el modelo principal y la prioridad vigente,
pero nunca devuelve la clave. Este endpoint es público para que el panel pueda mostrar el estado;
las operaciones de procesamiento y catalogo siguen protegidas por `IA_API_KEY`.

`GET /ia/modelos`

Devuelve los modelos disponibles para generar texto, la prioridad configurada e
indica mediante `compatibleCatalogo` cuáles pueden consultar el catálogo con File
Search. El filtro exige `generateContent`, capacidad de salida y excluye variantes
dedicadas a imagen, video, audio, Live, TTS, traducción, agentes, Computer Use,
embeddings y robótica. También devuelve los límites de contexto
`tokensEntrada`/`tokensSalida` informados por el endpoint de modelos.

Gemini no expone mediante la API key el consumo restante de RPM, TPM o RPD. Esos
límites se aplican por proyecto y deben consultarse en la página de Rate limits de
Google AI Studio. La API de modelos sólo informa capacidad de contexto; no informa
saldo de cuota.

`PUT /ia/modelos`

Recibe `{ "modelos": ["gemini-3.6-flash", "gemini-3.5-flash"] }`, valida que
todos estén disponibles para `generateContent` y persiste el orden. La operación
está protegida igual que el resto de la API de IA.

`GET /ia/prompts`

Devuelve al panel los prompts activos obtenidos desde API Firebird. La clave
`FIREBIRD_API_KEY` nunca se entrega al navegador.

### Catalogo propio de articulos

El panel `GET /ia/panel` permite cargar un archivo JSON con un array de
articulos. Cada elemento debe incluir `cod_art` y `descripcion`; el campo
`cant_vendida` es opcional. El servicio convierte los articulos en fichas,
crea un almacen persistente de Gemini File Search y guarda localmente su
identificador en `data/gemini-catalog.sqlite`.

- `GET /ia/catalogo`: informa el catalogo activo y la cantidad de articulos.
- `POST /ia/catalogo`: carga o reemplaza el catalogo mediante
  `multipart/form-data`, usando el campo `catalogo`.

Al reemplazarlo, el catalogo anterior se conserva hasta que el nuevo termina de
indexarse correctamente.

### Biblioteca de File Search Stores

El panel permite crear varios stores online de Gemini, cargar hasta cinco
documentos por vez en cada uno, consultar los documentos indexados y seleccionar
uno o varios stores para una solicitud.

Para las aplicaciones consumidoras, estos endpoints exponen los catalogos y
permiten elegir cual se usara por defecto:

- `GET /ia/catalogos`: lista los catalogos disponibles e informa
  `catalogoPredeterminado`.
- `PUT /ia/catalogos/predeterminado`: recibe
  `{ "catalogoStore": "fileSearchStores/articulos-abc123" }` y guarda esa
  eleccion de forma persistente.

- `GET /ia/file-search/stores`: lista los stores de la cuenta de Gemini.
- `POST /ia/file-search/stores`: crea un store con `{ "nombre": "Manuales" }`.
- `GET /ia/file-search/stores/:storeId/documentos`: lista sus documentos.
- `POST /ia/file-search/stores/:storeId/documentos`: carga e indexa documentos
  mediante `multipart/form-data`, usando `archivos`.
- `DELETE /ia/file-search/stores/:storeId/documentos/:documentId`: elimina un
  documento y sus fragmentos indexados.
- `DELETE /ia/file-search/stores/:storeId`: elimina un store completo y todos
  sus documentos.

El panel solicita confirmacion antes de eliminar. El store del catalogo activo
solo puede borrarse con `DELETE /ia/catalogo` o con su boton propio, para que el
registro local quede sincronizado con Gemini.

Para consultar varios stores, enviar sus nombres completos en
`fileSearchStores`. Gemini recibe una unica herramienta `fileSearch`; el campo
`fileSearchStoreNames` contiene todos los stores seleccionados y la busqueda se
realiza sobre el conjunto.

```json
{
  "instrucciones": "Compara las condiciones indicadas en los manuales y contratos",
  "fileSearchStores": [
    "fileSearchStores/manuales-abc123",
    "fileSearchStores/contratos-def456"
  ]
}
```

### Procesar datos JSON

`POST /ia/procesar`

```json
{
  "instrucciones": "Resume la conversacion e identifica asuntos pendientes",
  "contenido": "Cliente 1: necesito diez cajas para el viernes",
  "datos": {
    "conversaciones": [
      {
        "cliente": "Cliente 1",
        "mensajes": ["Necesito diez cajas para el viernes"]
      }
    ]
  },
  "formatoRespuesta": "json"
}
```

### Procesar uno o varios archivos

Enviar `multipart/form-data` con los campos:

- `instrucciones`: texto obligatorio.
- `contenido`: listado o texto a procesar, separado de las instrucciones. Es
  opcional cuando se adjunta uno o varios archivos.
- `archivo` o `archivos`: uno o varios archivos de cualquier tipo.
- `catalogoStore`: identificador del catalogo elegido, por ejemplo
  `fileSearchStores/catalogo-articulos-123`.
- `usarCatalogo`: controla el uso del catalogo. Con `true` usa
  `catalogoStore` si se envio y, en caso contrario, el catalogo predeterminado.
  Con `false` no consulta ningun catalogo, aunque se envie `catalogoStore`.
- `fileSearchStores`: array JSON con uno o varios stores adicionales.
- `datos`: JSON adicional opcional.
- `formatoRespuesta`: `texto` o `json`.
- `esquemaRespuesta`: JSON Schema opcional cuando el formato es `json`.

Ejemplo:

```bash
curl -X POST http://localhost:3002/ia/procesar \
  -F "instrucciones=Extrae los articulos con descripcion, cantidad y unidad" \
  -F "formatoRespuesta=json" \
  -F "usarCatalogo=true" \
  -F "catalogoStore=fileSearchStores/catalogo-articulos-123" \
  -F "archivo=@pedido.pdf;type=application/pdf"
```

`catalogoStore` es opcional. Por lo tanto, los clientes existentes que ya
envian solamente `usarCatalogo=true` no necesitan cambios.

Cuando se usa un catalogo, la respuesta incluye `catalogoUsado: true`. Gemini
lee el archivo adjunto y consulta solo las partes relevantes del catalogo
indexado, sin volver a enviar el JSON completo.

Cada solicitud comienza por el primer modelo de la prioridad central. Si devuelve
cuota agotada, saturación, indisponibilidad temporal, error de red o una respuesta
inválida, el servicio prueba el siguiente modelo configurado. Esto funciona con y
sin File Search; cuando se usa File Search se omiten los modelos incompatibles.
Los errores de autenticación o de solicitud inválida no generan fallback. El
campo `modeloSolicitado` informa el modelo principal, `modelo` el que respondió y
`modelosIntentados` la secuencia efectivamente recorrida. El campo `modelo` que
envíe un cliente se ignora: la selección pertenece exclusivamente a API
Mensajería.

Si Gemini rechaza definitivamente la solicitud, `/ia/procesar` conserva su
estado HTTP y el texto original en `error`. El cuerpo completo recibido de
Gemini queda disponible sin modificaciones en `gemini`.

La respuesta contiene un identificador, el modelo utilizado, el resultado y,
cuando Gemini lo informa, el consumo de tokens. El servicio conserva los campos
originales de Gemini y agrega `totalTokenCount` como nombre normalizado tanto
para `generateContent` como para Interactions:

```json
{
  "ok": true,
  "id": "3b132817-1abc-4b1c-963d-bec0f156a5d7",
  "modelo": "gemini-3.6-flash",
  "resultado": {
    "articulos": []
  },
  "uso": {
    "total_input_tokens": 1200,
    "total_output_tokens": 300,
    "total_tokens": 1500,
    "totalTokenCount": 1500
  }
}
```

Se procesan hasta cinco archivos de 10 MB cada uno y no se guardan en disco.
El servicio no filtra extensiones ni tipos MIME; la capacidad de interpretar el
contenido depende del modelo de Gemini configurado.

### Conversaciones con preguntas de aclaracion

`POST /ia/procesar` conserva su funcionamiento anterior. Para iniciar un flujo
conversacional, enviar `mantenerConversacion=true` en la primera solicitud. La
respuesta incluye:

- `chatId` y su alias `chat_id`.
- `requiereRespuesta`: indica si Gemini necesita una respuesta del usuario.
- `preguntas`: array de preguntas concretas.
- `estadoConversacion`: `esperando_respuesta` o `completado`.
- `resultado`: preguntas en texto mientras espera o el resultado final cuando
  la conversacion esta completa.
- `calidadRespuestas`: `no_aplica`, `suficientes`, `parciales` o
  `insuficientes`.
- `comentarioIa`: explica si el resultado dependio de respuestas, supuestos o
  decisiones tomadas durante el chat.
- `decisionesTomadas` y `advertencias`: trazabilidad de los criterios aplicados
  y de las limitaciones que quedaron pendientes.
- `requiereRevisionManual`: indica que la comparacion no deberia aprobarse de
  manera automatica.

Primera solicitud:

```bash
curl -X POST http://localhost:3002/ia/procesar \
  -H "X-API-Key: $IA_API_KEY" \
  -F "instrucciones=Compara la cotizacion con el catalogo y pregunta ante cualquier ambiguedad" \
  -F "mantenerConversacion=true" \
  -F "formatoRespuesta=json" \
  -F 'esquemaRespuesta={"type":"object","properties":{"articulos":{"type":"array","items":{"type":"string"}}},"required":["articulos"]}' \
  -F "usarCatalogo=true" \
  -F "archivo=@cotizacion.jpg;type=image/jpeg"
```

Cuando la primera solicitud usa `formatoRespuesta=json` y `esquemaRespuesta`, el
servicio persiste ambos junto al chat y vuelve a aplicar el esquema en cada ronda.
Mientras solicita aclaraciones devuelve `resultado` como texto de preguntas para
mantener la compatibilidad HTTP; internamente Gemini usa `null`. Al completar la
conversacion, `resultado` contiene directamente el objeto JSON validado, no texto
serializado.

Si `requiereRespuesta=true`, la app debe conservar `chatId` y enviar el turno
siguiente sin volver a adjuntar los archivos ni repetir el esquema:

```json
{
  "chatId": "33333333-3333-4333-8333-333333333333",
  "respuesta": "El cable solicitado es unipolar de 2,5 mm"
}
```

Cuando el usuario no puede aportar mas informacion, Gemini puede entregar una
comparacion de mejor esfuerzo. En ese caso devuelve el listado en `resultado`,
describe las decisiones en `comentarioIa` y marca
`requiereRevisionManual=true` si quedaron respuestas parciales, insuficientes
o supuestos relevantes.

Tambien se aceptan los nombres `chat_id` y `mantener_conversacion`. El contexto
multimodal se mantiene del lado de Gemini mediante Interactions API. El
webservice persiste en `data/gemini-conversations.sqlite` solamente el enlace
entre el `chatId` local, la ultima interaccion, el modelo y los stores usados.
También conserva el formato y el esquema de respuesta. En cada turno vuelve a
declarar las reglas, el esquema y File Search, pero la app cliente no necesita
reenviar las imagenes o documentos originales.

La vigencia local se configura con `IA_CHAT_TTL_HOURS` y por defecto es de 23
horas. `DELETE /ia/chats/:chatId` cierra el chat localmente.

## Normalizacion de telefonos de WhatsApp

- Elimina espacios, signos y caracteres no numericos.
- Si quedan 10 digitos, antepone `549`.
- Si ya empieza con `549`, lo deja igual.
- El JID final se arma como `numero@s.whatsapp.net`.

Ejemplos:

- `1122334455` => `5491122334455`
- `+54 9 11 2233-4455` => `5491122334455`

## Login de WhatsApp

1. Ejecutar `npm start`.
2. Abrir `http://localhost:3002/whatsapp/login`.
3. Escanear el QR con WhatsApp del telefono.
4. La sesion queda persistida en `wa_auth/`.

Si la sesion sigue valida, no vuelve a pedir QR.

## Notas

- WhatsApp puede limitar o bloquear cuentas si detecta spam.
- La pausa entre mensajes ayuda a bajar el riesgo, pero no lo elimina.
- Telegram requiere un token valido y permisos para escribir en el chat destino.
- Baileys depende de WhatsApp Web y puede requerir ajustes futuros si WhatsApp cambia algo internamente.
