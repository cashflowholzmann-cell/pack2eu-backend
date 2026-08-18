const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ============================================================
// 1. Shopify OAuth – Händler autorisiert die App
// ============================================================
router.get('/auth', (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: 'Shop-Parameter fehlt.' });
  
  const state = crypto.randomBytes(16).toString('hex');
  // In Production: State in Session oder DB speichern
  
  const authUrl = `https://${shop}/admin/oauth/authorize?client_id=${process.env.SHOPIFY_CLIENT_ID}&scope=read_products,read_orders&redirect_uri=${process.env.SHOPIFY_REDIRECT_URI}&state=${state}`;
  res.redirect(authUrl);
});

// ============================================================
// 2. Shopify OAuth Callback
// ============================================================
router.get('/callback', async (req, res) => {
  const { shop, code } = req.query;
  if (!shop || !code) return res.status(400).json({ error: 'Fehlende Parameter.' });
  
  try {
    const response = await axios.post(`https://${shop}/admin/oauth/access_token`, {
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
      code: code,
    });
    
    const { access_token } = response.data;
    
    // Hier muss der Kunde eingeloggt sein – vereinfacht: Token mit E-Mail verknüpfen
    // In Production: State aus Session holen
    const email = 'max@littleacorn.de'; // Aus Session
    db.prepare(`
      UPDATE customers 
      SET shopify_shop_domain = ?, shopify_access_token = ?, updated_at = datetime('now')
      WHERE email = ?
    `).run(shop, access_token, email);
    
    res.send('✅ Shopify erfolgreich verbunden!');
  } catch (err) {
    console.error('Shopify Auth Fehler:', err.message);
    res.status(500).send('❌ Fehler bei der Shopify-Verbindung.');
  }
});

// ============================================================
// 3. Shopify Webhook – Neue Bestellung
// ============================================================
router.post('/webhook/orders/create', async (req, res) => {
  try {
    const order = req.body;
    const shopDomain = req.headers['x-shopify-shop-domain'];
    
    const customer = db.prepare('SELECT * FROM customers WHERE shopify_shop_domain = ?').get(shopDomain);
    if (!customer) {
      console.error(`Kein Kunde für Shop ${shopDomain} gefunden.`);
      return res.status(404).send('Kunde nicht gefunden.');
    }
    
    const skus = db.prepare(`
      SELECT * FROM product_packaging WHERE customer_id = ?
    `).all(customer.id);
    
    const skuMap = {};
    skus.forEach(s => {
      if (s.shopify_product_id) skuMap[s.shopify_product_id] = s;
    });
    
    let totalWeight = 0;
    const packagingMaterials = [];
    
    order.line_items.forEach(item => {
      const sku = skuMap[item.product_id];
      if (sku) {
        const weight = sku.total_weight_grams * item.quantity;
        totalWeight += weight;
        const materials = JSON.parse(sku.materials_json);
        materials.forEach(m => {
          packagingMaterials.push({
            material: m.material,
            weight_grams: m.weight_grams * item.quantity,
            is_recyclable: m.is_recyclable
          });
        });
      }
    });
    
    const insert = db.prepare(`
      INSERT INTO shopify_orders 
      (customer_id, shopify_order_id, order_data_json, destination_country, total_weight_grams, packaging_data)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    insert.run(
      customer.id,
      order.id,
      JSON.stringify(order),
      order.shipping_address?.country_code || 'DE',
      totalWeight,
      JSON.stringify(packagingMaterials)
    );
    
    console.log(`✅ Bestellung ${order.id} verarbeitet: ${totalWeight}g`);
    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook Fehler:', err.message);
    res.status(500).send('Fehler');
  }
});

// ============================================================
// 4. Shopify-Produkte abrufen
// ============================================================
router.get('/products', requireAuth, async (req, res) => {
  try {
    const customer = db.prepare('SELECT shopify_access_token, shopify_shop_domain FROM customers WHERE id = ?').get(req.customer.sub);
    if (!customer?.shopify_access_token) {
      return res.status(400).json({ error: 'Shopify nicht verbunden.' });
    }
    
    const response = await axios.get(`https://${customer.shopify_shop_domain}/admin/api/2024-07/products.json`, {
      headers: { 'X-Shopify-Access-Token': customer.shopify_access_token }
    });
    
    res.json(response.data.products);
  } catch (err) {
    console.error('Shopify Produkte Fehler:', err.message);
    res.status(500).json({ error: 'Fehler beim Abrufen der Produkte.' });
  }
});

module.exports = router;
