import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys'
import express from 'express'
import axios from 'axios'
import QRCode from 'qrcode'
import pino from 'pino'
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs'

// ─── Config ────────────────────────────────────────────────────────────────
const PORT          = process.env.PORT || 3000
const N8N_WEBHOOK   = process.env.N8N_WEBHOOK_URL || 'https://primary-production-73794.up.railway.app/webhook/whatsapp'
const AUTH_DIR      = './auth_info'
const logger        = pino({ level: 'silent' })

if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR)

// ─── Estado global ──────────────────────────────────────────────────────────
let sock              = null
let qrBase64          = null
let isConnected       = false
let phoneNumber       = null
let manualDisconnect  = false   // ← FLAG: evita reconexión automática cuando desconectamos a propósito

// ─── Helpers ────────────────────────────────────────────────────────────────
function limpiarSesion () {
  try {
    const files = readdirSync(AUTH_DIR)
    for (const file of files) {
      unlinkSync(`${AUTH_DIR}/${file}`)
    }
    console.log('🗑️  Sesión limpiada')
  } catch (err) {
    console.error('Error limpiando sesión:', err.message)
  }
}

// ─── Express ────────────────────────────────────────────────────────────────
const app = express()
app.use(express.json())

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.sendStatus(200)
  next()
})

// GET /qr
app.get('/qr', (req, res) => {
  if (isConnected) {
    return res.json({ status: 'connected', phone: phoneNumber })
  }
  if (!qrBase64) {
    return res.json({ status: 'waiting', message: 'Generando QR, esperá unos segundos...' })
  }
  res.json({ status: 'qr', qr: qrBase64 })
})

// GET /status
app.get('/status', (req, res) => {
  res.json({
    connected: isConnected,
    phone: phoneNumber,
    timestamp: new Date().toISOString()
  })
})

// POST /send
app.post('/send', async (req, res) => {
  const { phone, message } = req.body

  if (!isConnected || !sock) {
    return res.status(503).json({ error: 'WhatsApp no conectado' })
  }
  if (!phone || !message) {
    return res.status(400).json({ error: 'Faltan phone o message' })
  }

  try {
    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`
    await sock.sendMessage(jid, { text: message })
    res.json({ success: true, to: jid })
  } catch (err) {
    console.error('Error enviando mensaje:', err)
    res.status(500).json({ error: err.message })
  }
})

// POST /disconnect — cierra sesión y genera nuevo QR automáticamente
app.post('/disconnect', async (req, res) => {
  try {
    manualDisconnect = true   // ← le avisamos al event handler que no reconecte solo

    // Cerrar socket actual
    if (sock) {
      try {
        await sock.logout()
      } catch (_) {
        // logout puede fallar si ya estaba desconectado, no importa
      }
      sock = null
    }

    // Resetear estado
    isConnected = false
    phoneNumber = null
    qrBase64    = null

    // Limpiar archivos de sesión
    limpiarSesion()

    // Responder al dashboard antes de reconectar
    res.json({ success: true, message: 'Desconectado. Generando nuevo QR...' })

    // Reconectar limpio para generar nuevo QR
    setTimeout(() => {
      manualDisconnect = false
      conectarWhatsApp()
    }, 1500)

  } catch (err) {
    console.error('Error al desconectar:', err)
    manualDisconnect = false
    res.status(500).json({ error: err.message })
  }
})

// ─── Baileys ────────────────────────────────────────────────────────────────
async function conectarWhatsApp () {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version }          = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    printQRInTerminal: false,
    browser: ['Prometeo CRM', 'Chrome', '1.0.0']
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.log('🔵 QR generado — esperando escaneo...')
      qrBase64    = await QRCode.toDataURL(qr)
      isConnected = false
    }

    if (connection === 'open') {
      isConnected = true
      qrBase64    = null
      phoneNumber = sock.user?.id?.split(':')[0] || null
      console.log(`✅ WhatsApp conectado — número: ${phoneNumber}`)
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      isConnected = false
      console.log(`⚠️ Desconectado — código: ${code}`)

      // Si fue desconexión manual, el /disconnect ya se encarga de reconectar
      if (manualDisconnect) {
        console.log('🔄 Desconexión manual — el endpoint maneja la reconexión')
        return
      }

      // Reconexión automática solo para caídas inesperadas (no logout)
      if (code !== DisconnectReason.loggedOut) {
        console.log('🔄 Reconectando automáticamente...')
        setTimeout(conectarWhatsApp, 3000)
      } else {
        // loggedOut inesperado (ej: el usuario cerró sesión desde el teléfono)
        console.log('🔴 Sesión cerrada desde el teléfono — limpiando y generando nuevo QR')
        limpiarSesion()
        qrBase64    = null
        phoneNumber = null
        setTimeout(conectarWhatsApp, 2000)
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      if (msg.key.fromMe) continue
      if (msg.key.remoteJid.endsWith('@g.us')) continue

      const from   = msg.key.remoteJid.replace('@s.whatsapp.net', '')
      const text   = msg.message?.conversation
                  || msg.message?.extendedTextMessage?.text
                  || ''
      const nombre = msg.pushName || ''

      if (!text) continue

      console.log(`📨 Mensaje de ${from}: ${text}`)

      try {
        await axios.post(N8N_WEBHOOK, {
          canal:     'whatsapp',
          from,
          nombre,
          mensaje:   text,
          timestamp: Date.now()
        })
      } catch (err) {
        console.error('Error enviando a n8n:', err.message)
      }
    }
  })
}

// ─── Iniciar ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Baileys service corriendo en puerto ${PORT}`)
  console.log(`📡 Webhook n8n: ${N8N_WEBHOOK}`)
  conectarWhatsApp()
})
