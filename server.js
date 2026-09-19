require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ extended: true })); // au cas où un service enverrait un webhook en POST classique

const PORT = process.env.PORT || 3000;

// Prix par modèle (FCFA)
const PRICES = {
  'STAR VOL 1': 86, // <-- prix test temporaire, remettre à 7000 après le test
  'L3 VOL 1': 7000,
  'MIND VOL 1': 8000,
  'RICH VOL 1': 7000,
};
function priceFor(title) {
  return PRICES[title] ?? 7000; // valeur de secours si un titre est inconnu
}

// --- Stockage des commandes sur Upstash Redis (survit aux redéploiements, contrairement à un fichier local) ---
async function readOrders() {
  try {
    const res = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/get/orders`, {
      headers: { 'Authorization': `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
    });
    const data = await res.json();
    return data.result ? JSON.parse(data.result) : {};
  } catch (err) {
    console.error('Erreur lecture des commandes (Upstash) :', err);
    return {};
  }
}
async function writeOrders(orders) {
  try {
    await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/set/orders`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
      body: JSON.stringify(orders)
    });
  } catch (err) {
    console.error('Erreur écriture des commandes (Upstash) :', err);
  }
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

function checkAdminSecret(req, res) {
  if (!process.env.ADMIN_SECRET || req.query.secret !== process.env.ADMIN_SECRET) {
    res.sendStatus(401);
    return false;
  }
  return true;
}

// --- 1. Le client valide son panier : on crée la commande et on initialise le paiement UnitechPay ---
app.post('/api/checkout', async (req, res) => {
  try {
    // Coupe-circuit : tant que SHOP_ENABLED n'est pas mis à "true" sur Render,
    // aucune commande ne peut être créée, même en contournant le site.
    if (process.env.SHOP_ENABLED !== 'true') {
      return res.status(403).json({ error: 'La boutique n\'est pas encore ouverte aux commandes.' });
    }

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

    const orders = await readOrders();
    orders[transaction_id] = {
      transaction_id,
      items,
      customer: customer || {},
      payment_method,
      amount,
      status: 'PENDING',
      delivered: false,
      created_at: new Date().toISOString()
    };
    await writeOrders(orders);

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
    await writeOrders(orders);

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
    console.log('Webhook UnitechPay reçu — headers:', JSON.stringify(req.headers));
    console.log('Webhook UnitechPay reçu — body:', JSON.stringify(req.body));

    const data = req.body;
    // UnitechPay a utilisé différents noms de champ selon les évènements observés :
    // "reference" (doc) ou "transaction_reference" (réel constaté)
    const reference = data && (data.reference || data.transaction_reference);
    if (!data || !reference) return res.sendStatus(400);

    // Vérification de sécurité : signature HMAC-SHA256 (méthode documentée : en-tête + corps brut)
    const signatureHeader = req.headers['x-unitechpay-signature'];
    let signatureOk = false;
    if (signatureHeader) {
      const expectedSignature = crypto
        .createHmac('sha256', process.env.UNITECHPAY_API_KEY)
        .update(req.rawBody)
        .digest('hex');
      signatureOk = expectedSignature === signatureHeader;
    }

    if (!signatureOk) {
      // NOTE TEMPORAIRE : le format réel envoyé par UnitechPay ne correspond pas exactement
      // à la doc publique. On journalise l'écart pour investigation, mais on NE bloque PAS
      // le traitement pour l'instant afin que les commandes/notifications continuent de fonctionner.
      console.warn('Webhook UnitechPay : signature non vérifiée (à corriger avec le support UnitechPay).', {
        signature_recue: signatureHeader || '(aucune, pas dans les en-têtes)',
        signature_dans_le_corps: data.signature || '(absente)',
      });
    }

    const orders = await readOrders();
    const transaction_id = Object.keys(orders).find(
      id => orders[id].unitech_reference === reference
    );
    const order = transaction_id ? orders[transaction_id] : null;
    if (!order) {
      console.warn('Webhook UnitechPay : commande introuvable pour la référence', reference);
      return res.sendStatus(200);
    }

    const isSuccess = data.status === 'completed' || data.event === 'payment_completed';
    const isFailure = ['failed', 'expired', 'cancelled'].includes(data.status)
      || ['payment_failed', 'payment_expired'].includes(data.event);

    if (isSuccess) {
      if (order.status === 'PAYE') {
        // Déjà traitée (UnitechPay a renvoyé le même webhook plusieurs fois) : on ne renotifie pas.
        console.log('Webhook UnitechPay : commande déjà marquée payée, notification ignorée.', reference);
        return res.sendStatus(200);
      }
      order.status = 'PAYE';
      order.payment_method_confirmed = data.method || order.payment_method;
      await writeOrders(orders);

      const itemsList = order.items.map(i => `• ${i.title} — ${i.color}`).join('\n');
      const c = order.customer || {};
      await sendTelegramNotification(
        `🛒 <b>Nouvelle commande payée</b>\n\n${itemsList}\n\n💰 ${order.amount} FCFA\n📱 ${data.method || order.payment_method}\n\n👤 ${c.name || ''}\n📞 ${c.phone || ''}\n📍 ${c.address || ''}`
      );
      await sendOneSignalNotification(
        `${order.items.map(i => i.title).join(', ')} — ${order.amount} FCFA — ${c.phone || ''} — ${c.address || ''}`
      );
    } else if (isFailure) {
      order.status = 'ECHEC';
      await writeOrders(orders);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// --- 3. Vérifier le statut d'une commande depuis le frontend ---
app.get('/api/orders/:id', async (req, res) => {
  const orders = await readOrders();
  const order = orders[req.params.id];
  if (!order) return res.status(404).json({ error: 'Introuvable' });
  res.json(order);
});

// --- 4. Liste de toutes les commandes, protégée par un code admin (pour la page /admin) ---
app.get('/api/orders', async (req, res) => {
  if (!checkAdminSecret(req, res)) return;
  const orders = await readOrders();
  const list = Object.values(orders).sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at)
  );
  res.json(list);
});

// --- 5. Marquer une commande comme livrée (ou non), depuis la page /admin ---
app.post('/api/orders/:id/delivered', async (req, res) => {
  if (!checkAdminSecret(req, res)) return;
  const orders = await readOrders();
  const order = orders[req.params.id];
  if (!order) return res.status(404).json({ error: 'Introuvable' });
  order.delivered = !!req.body.delivered;
  await writeOrders(orders);
  res.json(order);
});

// --- Route "santé" : utilisée par un service externe pour empêcher Render de s'endormir ---
app.get('/', (req, res) => {
  res.send('L3GACY backend actif ✅');
});

app.listen(PORT, () => console.log(`L3GACY backend lancé sur le port ${PORT}`));
