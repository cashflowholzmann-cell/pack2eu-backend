const express = require('express');
const { db } = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT code, name, register_body, labeling_reqs FROM countries ORDER BY name').all();
  const countries = rows.map((r) => ({
    ...r,
    labeling_reqs: JSON.parse(r.labeling_reqs),
  }));
  res.json(countries);
});

module.exports = router;
