const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware');
const { getOptionPrice } = require('../poolMath');

const router = express.Router();

router.get('/mine', requireAuth, async (req, res) => {
    try {
        const rows = await db.prepare(`
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
    } catch (err) {
        console.error('Erreur GET /bets/mine :', err);
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

// Place un pari : { marketId, optionId, direction: 'YES'|'NO', amount }
router.post('/', requireAuth, async (req, res) => {
    try {
        const { marketId, optionId, direction, amount } = req.body || {};
        const stake = Number(amount);

        if (!stake || stake <= 0) {
            return res.status(400).json({ error: 'Montant invalide.' });
        }
        if (direction !== 'YES' && direction !== 'NO') {
            return res.status(400).json({ error: 'Direction invalide.' });
        }

        const market = await db.prepare('SELECT * FROM markets WHERE id = ?').get(marketId);
        if (!market || market.resolved) {
            return res.status(400).json({ error: 'Marché indisponible.' });
        }
        const option = await db.prepare('SELECT * FROM options WHERE id = ? AND market_id = ?').get(optionId, marketId);
        if (!option) return res.status(404).json({ error: 'Option introuvable.' });

        if (req.user.balance < stake) {
            return res.status(400).json({ error: `Solde insuffisant (${req.user.balance.toFixed(2)} Ɇ disponible).` });
        }

        const price = getOptionPrice(option, direction);
        const estimatedPayout = Math.round((stake / (price / 100)) * 100) / 100;

        await db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(stake, req.user.id);
        if (direction === 'YES') {
            await db.prepare('UPDATE options SET real_yes = real_yes + ? WHERE id = ?').run(stake, option.id);
        } else {
            await db.prepare('UPDATE options SET real_no = real_no + ? WHERE id = ?').run(stake, option.id);
        }
        const info = await db.prepare(`
            INSERT INTO bets (user_id, market_id, option_id, direction, amount, price_at_bet, payout, status, seen, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?) RETURNING id
        `).run(req.user.id, marketId, optionId, direction, stake, price, estimatedPayout, Date.now());

        // Un vrai point d'historique de prix, pour le graphique.
        const updatedOption = await db.prepare('SELECT * FROM options WHERE id = ?').get(option.id);
        const total = updatedOption.seed_yes + updatedOption.real_yes + updatedOption.seed_no + updatedOption.real_no;
        const chance = total > 0 ? Math.round(((updatedOption.seed_yes + updatedOption.real_yes) / total) * 1000) / 10 : 50;
        await db.prepare('INSERT INTO price_history (option_id, t, value) VALUES (?, ?, ?)').run(option.id, Date.now(), chance);

        const betId = info.lastInsertRowid;
        const newBalance = (await db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.id)).balance;
        res.status(201).json({ betId, price, newBalance });
    } catch (err) {
        console.error('Erreur POST /bets :', err);
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

// Annule un pari en attente : remboursement à 90%.
router.post('/:id/cancel', requireAuth, async (req, res) => {
    try {
        const bet = await db.prepare('SELECT * FROM bets WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
        if (!bet || bet.status !== 'pending') {
            return res.status(400).json({ error: 'Pari introuvable ou déjà résolu.' });
        }

        const refund = Math.round(bet.amount * 0.9 * 100) / 100;

        // NB : MAX(a, b) n'existe pas en PostgreSQL (seulement en agrégat) ;
        // on calcule donc le plafond à 0 côté JS plutôt qu'en SQL.
        const option = await db.prepare('SELECT * FROM options WHERE id = ?').get(bet.option_id);
        if (bet.direction === 'YES') {
            const newYes = Math.max(0, (option ? option.real_yes : 0) - bet.amount);
            await db.prepare('UPDATE options SET real_yes = ? WHERE id = ?').run(newYes, bet.option_id);
        } else {
            const newNo = Math.max(0, (option ? option.real_no : 0) - bet.amount);
            await db.prepare('UPDATE options SET real_no = ? WHERE id = ?').run(newNo, bet.option_id);
        }
        await db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(refund, req.user.id);
        await db.prepare('DELETE FROM bets WHERE id = ?').run(bet.id);

        const newBalance = (await db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.id)).balance;
        res.json({ ok: true, refund, newBalance });
    } catch (err) {
        console.error('Erreur POST /bets/:id/cancel :', err);
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

// Marque des paris gagnés comme "vus".
router.post('/mark-seen', requireAuth, async (req, res) => {
    try {
        const { betIds } = req.body || {};
        if (!Array.isArray(betIds) || betIds.length === 0) return res.json({ ok: true });
        for (const id of betIds) {
            await db.prepare('UPDATE bets SET seen = 1 WHERE id = ? AND user_id = ?').run(id, req.user.id);
        }
        res.json({ ok: true });
    } catch (err) {
        console.error('Erreur POST /bets/mark-seen :', err);
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

module.exports = router;
