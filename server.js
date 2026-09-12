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

    const cinetpayRes = await fetch('https://api-checkout.cinetpay.com/v2/payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apikey: process.env.CINETPAY_APIKEY,
        site_id: process.env.CINETPAY_SITE_ID,
        transaction_id,
        amount,
        currency: 'XOF',
        description: `Commande L3GACY - ${items.map(i => i.title).join(', ')}`,
        channels: 'ALL', // le client choisit Wave / Orange Money / carte sur la page CinetPay
        notify_url: process.env.NOTIFY_URL,   // ex: https://ton-backend.onrender.com/api/webhook/cinetpay
        return_url: process.env.RETURN_URL,   // ex: https://l3gacy.netlify.app/merci
        customer_name: (customer?.name || 'Client L3GACY').split(' ')[0],
        customer_surname: (customer?.name || 'Client L3GACY').split(' ').slice(1).join(' ') || 'L3GACY',
        customer_phone_number: customer?.phone || '',
        customer_address: customer?.address || '',
        customer_city: customer?.city || 'Dakar',
        customer_country: 'SN',
      })
    });

    const data = await cinetpayRes.json();

    if (data.code !== '201' && data.code !== 201) {
      console.error('Erreur CinetPay:', data);
      return res.status(500).json({ error: 'Impossible de créer le paiement.', details: data });
    }

    // data.data.payment_url : lien vers la page de paiement CinetPay (Wave / Orange Money / carte)
    res.json({ payment_url: data.data.payment_url, transaction_id });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// --- 2. CinetPay appelle cette URL automatiquement dès que le paiement change de statut ---
app.post('/api/webhook/cinetpay', async (req, res) => {
  try {
    const { cpm_trans_id } = req.body;
    if (!cpm_trans_id) return res.sendStatus(400);

    // On revérifie toujours le statut auprès de CinetPay (ne jamais faire confiance au webhook seul)
    const checkRes = await fetch('https://api-checkout.cinetpay.com/v2/payment/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apikey: process.env.CINETPAY_APIKEY,
        site_id: process.env.CINETPAY_SITE_ID,
        transaction_id: cpm_trans_id,
      })
    });
    const check = await checkRes.json();

    const orders = readOrders();
    const order = orders[cpm_trans_id];
    if (!order) return res.sendStatus(200);

    if (check.data && check.data.status === 'ACCEPTED') {
      order.status = 'PAYE';
      order.payment_method = check.data.payment_method;
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
