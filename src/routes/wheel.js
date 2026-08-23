const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware');

const router = express.Router();

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Mêmes segments que la roue du prototype (8 cases, probabilités pondérées).
const SEGMENTS = [
    { label: '10 Ɇ', value: 10, weight: 3 },
    { label: '20 Ɇ', value: 20, weight: 2 },
    { label: '50 Ɇ', value: 50, weight: 2 },
    { label: '100 Ɇ', value: 100, weight: 1 },
];

function pickWeighted() {
    const total = SEGMENTS.reduce((s, seg) => s + seg.weight, 0);
    let roll = Math.random() * total;
    for (const seg of SEGMENTS) {
        if (roll < seg.weight) return seg;
        roll -= seg.weight;
    }
    return SEGMENTS[0];
}

// Temps restant avant de pouvoir retourner la roue (0 si dispo maintenant,
// toujours 0 pour les admins qui n'ont pas de limite).
function msUntilNextSpin(user) {
    if (user.is_admin) return 0;
    if (!user.last_wheel_spin_at) return 0;
    const elapsed = Date.now() - user.last_wheel_spin_at;
    return Math.max(0, ONE_DAY_MS - elapsed);
}

router.get('/status', requireAuth, (req, res) => {
    res.json({ msUntilNextSpin: msUntilNextSpin(req.user) });
});

// Le tirage est décidé ici, jamais côté client. Limité à 1x/jour pour
// les non-admins (les admins tournent librement).
router.post('/spin', requireAuth, async (req, res) => {
    try {
        const remaining = msUntilNextSpin(req.user);
        if (remaining > 0) {
            const hours = Math.ceil(remaining / (60 * 60 * 1000));
            return res.status(429).json({ error: `Encore un peu de patience : prochain tour dans ${hours}h environ.`, msUntilNextSpin: remaining });
        }

        const won = pickWeighted();

        await db.prepare('UPDATE users SET balance = balance + ?, last_wheel_spin_at = ? WHERE id = ?')
            .run(won.value, Date.now(), req.user.id);
        const newBalance = (await db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.id)).balance;

        res.json({ value: won.value, label: won.label, newBalance });
    } catch (err) {
        console.error('Erreur POST /wheel/spin :', err);
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

module.exports = router;
