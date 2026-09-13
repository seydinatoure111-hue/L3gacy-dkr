require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // CinetPay envoie le webhook en POST classique

const PORT = process.env.PORT || 3000;
const ORDERS_FILE = path.join(__dirname, 'orders.json');

// Prix par modèle (FCFA)
const PRICES = {
  'STAR VOL 1': 7000,
  'L3 VOL 1': 7000,
  'MIND VOL 1': 8000,
  'RICH VOL 1': 7000,
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

// --- 1. Le client valide son panier : on crée la commande et on initialise le paiement CinetPay ---
app.post('/api/checkout', async (req, res) => {
  try {
    const { items, customer } = req.body;
    // items attendu : [{ title: "STAR VOL 1", color: "Blanc" }, ...]

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Panier vide.' });
    }

    const transaction_id = uuidv4();
    const amount = items.reduce((sum, item) => sum + priceFor(item.title), 0);

    const orders = readOrders();
    orders[transaction_id] = {
      transaction_id,
      items,
      customer: customer || {},
      amount,
      status: 'PENDING',
      created_at: new Date().toISOString()
    };
    writeOrders(orders);

    const paytechRes = await fetch('https://paytech.sn/api/payment/request-payment', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'API_KEY': process.env.PAYTECH_API_KEY,
        'API_SECRET': process.env.PAYTECH_API_SECRET,
      },
      body: JSON.stringify({
        item_name: items.map(i => i.title).join(', '),
        item_price: amount,
        currency: 'XOF',
        ref_command: transaction_id,
        command_name: `Commande L3GACY - ${items.map(i => i.title).join(', ')}`,
        env: process.env.PAYTECH_ENV || 'test', // passe à "prod" une fois le compte activé
        ipn_url: process.env.NOTIFY_URL,   // ex: https://ton-backend.onrender.com/api/webhook/paytech
        success_url: process.env.RETURN_URL,
        cancel_url: process.env.RETURN_URL,
        custom_field: JSON.stringify({
          name: customer?.name || '',
          phone: customer?.phone || '',
          address: customer?.address || '',
        })
      })
    });

    const data = await paytechRes.json();

    if (data.success !== 1) {
      console.error('Erreur PayTech:', data);
      return res.status(500).json({ error: 'Impossible de créer le paiement.', details: data });
    }

    // data.redirect_url : lien vers la page de paiement PayTech (Wave / Orange Money / carte)
    res.json({ payment_url: data.redirect_url, transaction_id });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// --- 2. PayTech appelle cette URL automatiquement dès que le paiement est confirmé ---
app.post('/api/webhook/paytech', async (req, res) => {
  try {
    const { type_event, ref_command, item_price, payment_method, api_key_sha256, api_secret_sha256, client_phone } = req.body;
    if (!ref_command) return res.sendStatus(400);

    // Vérification de sécurité : le hash doit correspondre à nos propres clés
    const crypto = require('crypto');
    const expectedKeyHash = crypto.createHash('sha256').update(process.env.PAYTECH_API_KEY).digest('hex');
    const expectedSecretHash = crypto.createHash('sha256').update(process.env.PAYTECH_API_SECRET).digest('hex');

    if (api_key_sha256 !== expectedKeyHash || api_secret_sha256 !== expectedSecretHash) {
      console.error('Webhook PayTech : signature invalide, requête ignorée.');
      return res.sendStatus(403);
    }

    const orders = readOrders();
    const order = orders[ref_command];
    if (!order) return res.sendStatus(200);

    if (type_event === 'sale_complete') {
      order.status = 'PAYE';
      order.payment_method = payment_method || '';
      writeOrders(orders);

      const itemsList = order.items.map(i => `• ${i.title} — ${i.color}`).join('\n');
      const c = order.customer || {};
      await sendTelegramNotification(
        `🛒 <b>Nouvelle commande payée</b>\n\n${itemsList}\n\n💰 ${order.amount} FCFA\n📱 ${order.payment_method || ''}\n\n👤 ${c.name || ''}\n📞 ${c.phone || ''}\n📍 ${c.address || ''}`
      );
      await sendOneSignalNotification(
        `${order.items.map(i => i.title).join(', ')} — ${order.amount} FCFA — ${c.phone || ''}`
      );
    } else {
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
