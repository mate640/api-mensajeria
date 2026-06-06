# mensajeria-service

Microservicio Node.js separado para enviar mensajes por WhatsApp y Telegram mediante endpoints REST simples.

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
    health.js
    telegram.js
    whatsapp.js
  services/
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
curl -X POST http://localhost:3001/whatsapp/enviar-sync ^
  -H "Content-Type: application/json" ^
  -d "{\"destinos\":[{\"numero\":\"1122334455\",\"nombre\":\"Juan\"}],\"mensaje\":\"Hola {nombre}, este es un mensaje de prueba.\",\"pausa\":3500}"
```

### Envio en background

`POST /whatsapp/enviar`

Responde enseguida con un `jobId` y procesa el lote en segundo plano.

## Telegram

Base: `/telegram`

### Estado

`GET /telegram/estado`

### Envio secuencial

`POST /telegram/enviar-sync`

Ejemplo:

```bash
curl -X POST http://localhost:3001/telegram/enviar-sync ^
  -H "Content-Type: application/json" ^
  -d "{\"destinos\":[{\"chatId\":\"123456789\",\"nombre\":\"Jorge\"}],\"mensaje\":\"Hola {nombre}, este es un aviso automatico.\",\"pausa\":1000}"
```

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
2. Abrir `http://localhost:3001/whatsapp/login`.
3. Escanear el QR con WhatsApp del telefono.
4. La sesion queda persistida en `wa_auth/`.

Si la sesion sigue valida, no vuelve a pedir QR.

## Notas

- WhatsApp puede limitar o bloquear cuentas si detecta spam.
- La pausa entre mensajes ayuda a bajar el riesgo, pero no lo elimina.
- Telegram requiere un token valido y permisos para escribir en el chat destino.
- Baileys depende de WhatsApp Web y puede requerir ajustes futuros si WhatsApp cambia algo internamente.
