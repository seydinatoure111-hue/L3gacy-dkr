require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ extended: true })); // au cas où un service enverrait un webhook en POST classique

const PORT = process.env.PORT || 3000;
const ORDERS_FILE = path.join(__dirname, 'orders.json');

// Prix par modèle (FCFA)
const PRICES = {
  'STAR VOL 1': 7000,
  'L3 VOL 1': 7000,
  'MIND VOL 1': 8000,
  'RICH VOL 1': 7000,
  'TEE SHIRT DOOM': 1, // <-- produit test à 1 FCFA, à supprimer après le test
};
function priceFor(title) {
  return PRICES[title] ?? 7000; // valeur de secours si un titre est inconnu
}

// --- Stockage simple des commandes (fichier JSON, suffisant pour démarrer) ---
function readOrders() {
  if (!fs.existsSync(ORDERS_FILE)) return {};
  return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf-8'));
}
function writeOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

// --- Notification OneSignal (push web, arrive comme une notif classique sur le téléphone) ---
async function sendOneSignalNotification(text) {
  const appId = process.env.ONESIGNAL_APP_ID;
  const apiKey = process.env.ONESIGNAL_REST_API_KEY;
  if (!appId || !apiKey) {
    console.warn('OneSignal non configuré (ONESIGNAL_APP_ID / ONESIGNAL_REST_API_KEY manquants)');
    return;
  }
  await fetch('https://api.onesignal.com/notifications', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Key ${apiKey}`
    },
    body: JSON.stringify({
      app_id: appId,
      target_channel: 'push',
      include_aliases: { external_id: ['l3gacy-admin'] }, // cible uniquement ton appareil, activé via admin.html
      headings: { en: 'Nouvelle commande L3GACY' },
      contents: { en: text }
    })
  });
}

// --- Notification Telegram ---
async function sendTelegramNotification(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('Telegram non configuré (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID manquants)');
    return;
  }
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
}

// --- UnitechPay : petit client HTTP réutilisable ---
const UNITECHPAY_BASE = 'https://api.unitech.sn/api.php';
async function unitechRequest(action, data = {}) {
  const response = await fetch(`${UNITECHPAY_BASE}?action=${action}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.UNITECHPAY_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(data)
  });
  return response.json();
}

// --- 1. Le client valide son panier : on crée la commande et on initialise le paiement UnitechPay ---
app.post('/api/checkout', async (req, res) => {
  try {
    const { items, customer, payment_method } = req.body;
    // items attendu : [{ title: "STAR VOL 1", color: "Blanc" }, ...]
    // payment_method attendu : "wave" ou "orange"

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Panier vide.' });
    }
    if (!['wave', 'orange'].includes(payment_method)) {
      return res.status(400).json({ error: 'Mode de paiement invalide (wave ou orange attendu).' });
    }

    const transaction_id = uuidv4();
    const amount = items.reduce((sum, item) => sum + priceFor(item.title), 0);
    const description = `Commande L3GACY - ${items.map(i => i.title).join(', ')}`;

    const orders = readOrders();
    orders[transaction_id] = {
      transaction_id,
      items,
      customer: customer || {},
      payment_method,
      amount,
      status: 'PENDING',
      created_at: new Date().toISOString()
    };
    writeOrders(orders);

    const unitechAction = payment_method === 'wave' ? 'create_wave_payment' : 'create_orange_om';

    const unitechRes = await unitechRequest(unitechAction, {
      amount,
      customer_number: customer?.phone || '',
      description,
      callback_success: process.env.RETURN_URL,
      callback_cancel: process.env.RETURN_URL,
    });

    if (!unitechRes.success) {
      console.error('Erreur UnitechPay:', unitechRes);
      return res.status(500).json({ error: 'Impossible de créer le paiement.', details: unitechRes });
    }

    // On garde la référence UnitechPay pour retrouver la commande quand le webhook arrivera
    orders[transaction_id].unitech_reference = unitechRes.data.reference;
    orders[transaction_id].unitech_transaction_id = unitechRes.data.transaction_id;
    writeOrders(orders);

    // data.payment_url : lien vers la page de paiement (Wave) ou deep link Orange Money
    res.json({ payment_url: unitechRes.data.payment_url, transaction_id });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// --- 2. UnitechPay appelle cette URL automatiquement dès que le paiement est confirmé ---
app.post('/api/webhook/unitechpay', async (req, res) => {
  try {
    console.log('Webhook UnitechPay reçu:', JSON.stringify(req.body));

    const data = req.body;
    if (!data || !data.reference) return res.sendStatus(400);

    // Vérification de sécurité : signature HMAC-SHA256 sur le corps brut de la requête
    const signature = req.headers['x-unitechpay-signature'];
    const expectedSignature = crypto
      .createHmac('sha256', process.env.UNITECHPAY_API_KEY)
      .update(req.rawBody)
      .digest('hex');

    if (!signature || expectedSignature !== signature) {
      console.error('Webhook UnitechPay : signature invalide, requête ignorée.', {
        signature_recue: signature || '(aucune)',
      });
      return res.sendStatus(401);
    }

    const orders = readOrders();
    const transaction_id = Object.keys(orders).find(
      id => orders[id].unitech_reference === data.reference
    );
    const order = transaction_id ? orders[transaction_id] : null;
    if (!order) return res.sendStatus(200);

    if (data.event === 'payment_completed') {
      order.status = 'PAYE';
      order.payment_method_confirmed = data.method || order.payment_method;
      writeOrders(orders);

      const itemsList = order.items.map(i => `• ${i.title} — ${i.color}`).join('\n');
      const c = order.customer || {};
      await sendTelegramNotification(
        `🛒 <b>Nouvelle commande payée</b>\n\n${itemsList}\n\n💰 ${order.amount} FCFA\n📱 ${data.method || order.payment_method}\n\n👤 ${c.name || ''}\n📞 ${c.phone || ''}\n📍 ${c.address || ''}`
      );
      await sendOneSignalNotification(
        `${order.items.map(i => i.title).join(', ')} — ${order.amount} FCFA — ${c.phone || ''}`
      );
    } else if (data.event === 'payment_failed' || data.event === 'payment_expired') {
      order.status = 'ECHEC';
      writeOrders(orders);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// --- 3. Optionnel : vérifier le statut d'une commande depuis le frontend ---
app.get('/api/orders/:id', (req, res) => {
  const orders = readOrders();
  const order = orders[req.params.id];
  if (!order) return res.status(404).json({ error: 'Introuvable' });
  res.json(order);
});

app.listen(PORT, () => console.log(`L3GACY backend lancé sur le port ${PORT}`));
