const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware');
const { getOptionPrice } = require('../poolMath');

const router = express.Router();

router.get('/mine', requireAuth, (req, res) => {
    const rows = db.prepare(`
        SELECT bets.*, markets.title AS market_title, markets.market_type, options.name AS option_name
        FROM bets
        JOIN markets ON markets.id = bets.market_id
        JOIN options ON options.id = bets.option_id
        WHERE bets.user_id = ?
        ORDER BY bets.created_at DESC
    `).all(req.user.id);

    res.json({
        bets: rows.map(b => ({
            id: b.id,
            marketId: b.market_id,
            marketTitle: b.market_title,
            marketType: b.market_type,
            option: b.market_type === 'binary' ? (b.direction === 'YES' ? 'Oui' : 'Non') : b.option_name,
            direction: b.direction,
            amount: b.amount,
            payout: b.payout,
            status: b.status,
            seen: !!b.seen,
            timestamp: b.created_at
        }))
    });
});

// Place un pari : { marketId, optionId, direction: 'YES'|'NO', amount }
router.post('/', requireAuth, (req, res) => {
    const { marketId, optionId, direction, amount } = req.body || {};
    const stake = Number(amount);

    if (!stake || stake <= 0) {
        return res.status(400).json({ error: 'Montant invalide.' });
    }
    if (direction !== 'YES' && direction !== 'NO') {
        return res.status(400).json({ error: 'Direction invalide.' });
    }

    const market = db.prepare('SELECT * FROM markets WHERE id = ?').get(marketId);
    if (!market || market.resolved) {
        return res.status(400).json({ error: 'Marché indisponible.' });
    }
    const option = db.prepare('SELECT * FROM options WHERE id = ? AND market_id = ?').get(optionId, marketId);
    if (!option) return res.status(404).json({ error: 'Option introuvable.' });

    if (req.user.balance < stake) {
        return res.status(400).json({ error: `Solde insuffisant (${req.user.balance.toFixed(2)} Ɇ disponible).` });
    }

    const price = getOptionPrice(option, direction);
    // Estimation du gain au moment du pari (le paiement réel, façon PMU, ne
    // sera connu qu'à la résolution -> voir isEstimate côté client).
    const estimatedPayout = Math.round((stake / (price / 100)) * 100) / 100;

    const tx = db.transaction(() => {
        db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(stake, req.user.id);
        if (direction === 'YES') {
            db.prepare('UPDATE options SET real_yes = real_yes + ? WHERE id = ?').run(stake, option.id);
        } else {
            db.prepare('UPDATE options SET real_no = real_no + ? WHERE id = ?').run(stake, option.id);
        }
        const info = db.prepare(`
            INSERT INTO bets (user_id, market_id, option_id, direction, amount, price_at_bet, payout, status, seen, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?)
        `).run(req.user.id, marketId, optionId, direction, stake, price, estimatedPayout, Date.now());

        // Un vrai point d'historique de prix, pour le graphique (voir price_history).
        const updatedOption = db.prepare('SELECT * FROM options WHERE id = ?').get(option.id);
        const total = updatedOption.seed_yes + updatedOption.real_yes + updatedOption.seed_no + updatedOption.real_no;
        const chance = total > 0 ? Math.round(((updatedOption.seed_yes + updatedOption.real_yes) / total) * 1000) / 10 : 50;
        db.prepare('INSERT INTO price_history (option_id, t, value) VALUES (?, ?, ?)').run(option.id, Date.now(), chance);

        return info.lastInsertRowid;
    });

    const betId = tx();
    const newBalance = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.id).balance;
    res.status(201).json({ betId, price, newBalance });
});

// Annule un pari en attente : remboursement à 90%, retire la mise complète
// des cagnottes (les 10% de pénalité disparaissent de la circulation).
router.post('/:id/cancel', requireAuth, (req, res) => {
    const bet = db.prepare('SELECT * FROM bets WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!bet || bet.status !== 'pending') {
        return res.status(400).json({ error: 'Pari introuvable ou déjà résolu.' });
    }

    const refund = Math.round(bet.amount * 0.9 * 100) / 100;

    const tx = db.transaction(() => {
        if (bet.direction === 'YES') {
            db.prepare('UPDATE options SET real_yes = MAX(0, real_yes - ?) WHERE id = ?').run(bet.amount, bet.option_id);
        } else {
            db.prepare('UPDATE options SET real_no = MAX(0, real_no - ?) WHERE id = ?').run(bet.amount, bet.option_id);
        }
        db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(refund, req.user.id);
        db.prepare('DELETE FROM bets WHERE id = ?').run(bet.id);
    });
    tx();

    const newBalance = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.id).balance;
    res.json({ ok: true, refund, newBalance });
});

// Marque des paris gagnés comme "vus" (pour ne pas rejouer l'animation de
// victoire à chaque chargement de page).
router.post('/mark-seen', requireAuth, (req, res) => {
    const { betIds } = req.body || {};
    if (!Array.isArray(betIds) || betIds.length === 0) return res.json({ ok: true });
    const stmt = db.prepare('UPDATE bets SET seen = 1 WHERE id = ? AND user_id = ?');
    const tx = db.transaction(() => betIds.forEach(id => stmt.run(id, req.user.id)));
    tx();
    res.json({ ok: true });
});

module.exports = router;
