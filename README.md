# Prometeo — Baileys WhatsApp Service

Servicio que conecta WhatsApp con n8n via Baileys.

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | /qr | Obtener QR para escanear (o estado si ya conectado) |
| GET | /status | Estado de la conexión |
| POST | /send | Enviar mensaje `{ phone, message }` |
| POST | /disconnect | Cerrar sesión |

## Deploy en Railway

### 1. Subir el código a GitHub
```bash
git init
git add .
git commit -m "Prometeo Baileys Service"
git remote add origin https://github.com/TU_USUARIO/prometeo-baileys
git push -u origin main
```

### 2. Crear servicio en Railway
- railway.app → New Project → Deploy from GitHub repo
- Seleccioná el repo `prometeo-baileys`
- Railway detecta el Dockerfile automáticamente

### 3. Agregar Volume (IMPORTANTE)
- En Railway → tu servicio → Volumes → Add Volume
- Mount path: `/app/auth_info`
- Esto guarda la sesión de WhatsApp aunque el servicio se reinicie

### 4. Variables de entorno en Railway
```
N8N_WEBHOOK_URL=https://primary-production-73794.up.railway.app/webhook/whatsapp
PORT=3000
```

### 5. Una vez desplegado
- Railway te da una URL pública (ej: `https://prometeo-baileys.up.railway.app`)
- Abrí `https://TU-URL/qr` para ver el QR
- Escanealo con WhatsApp → Dispositivos vinculados → Vincular dispositivo

## Flujo completo

```
Usuario escribe por WhatsApp
→ Baileys recibe el mensaje
→ POST a n8n webhook con { canal, from, nombre, mensaje }
→ n8n procesa con Zoe
→ n8n hace POST a /send con { phone, message }
→ Baileys envía la respuesta por WhatsApp
```

## Adaptación del WF-08 en n8n

El workflow actual tiene Telegram Trigger. Para WhatsApp:
1. Reemplazar "Telegram Trigger" por nodo "Webhook" (POST, path: whatsapp)
2. Reemplazar "Enviar por Telegram" por HTTP Request POST a `https://TU-BAILEYS-URL/send`
   con body: `{ "phone": "{{ $json.from }}", "message": "{{ $json.respuesta_bot }}" }`
